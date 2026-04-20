import { execFileSync } from 'child_process';
import { createLogger } from '@media-router/shared-types';
import type { PaCommandQueue } from './PaCommandQueue.js';
import { MR_PW_PREFIX, type AudioDevice } from './PipeWireManager.js';

const log = createLogger('AudioDeviceOps');

/**
 * Audio device operations: volume control and device enumeration.
 * Volume commands go through PaCommandQueue for rate limiting.
 * Device listing uses execFileSync directly (read-only).
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

        try {
            // Parse full source list for descriptions and channel info
            const sourceOutput = execFileSync('pactl', ['list', 'sources'], {
                encoding: 'utf-8',
                timeout: 5000,
                env: { ...process.env, DISPLAY: '' },
            });
            for (const block of sourceOutput.split('\n\n')) {
                const nameMatch = block.match(/Name:\s*(.+)/);
                const descMatch = block.match(/Description:\s*(.+)/);
                const specMatch = block.match(/Sample Specification:\s*\S+\s+(\d+)ch\s+(\d+)Hz/);
                if (!nameMatch) continue;
                const name = nameMatch[1].trim();
                if (name.endsWith('.monitor')) continue; // skip monitors
                if (name.startsWith(MR_PW_PREFIX)) continue; // skip our own modules
                devices.push({
                    id: 0,
                    name,
                    description: descMatch?.[1]?.trim() ?? name,
                    direction: 'source',
                    channels: specMatch?.[1] ? parseInt(specMatch[1], 10) || undefined : undefined,
                    sampleRate: specMatch?.[2]
                        ? parseInt(specMatch[2], 10) || undefined
                        : undefined,
                });
            }

            // Parse full sink list
            const sinkOutput = execFileSync('pactl', ['list', 'sinks'], {
                encoding: 'utf-8',
                timeout: 5000,
                env: { ...process.env, DISPLAY: '' },
            });
            for (const block of sinkOutput.split('\n\n')) {
                const nameMatch = block.match(/Name:\s*(.+)/);
                const descMatch = block.match(/Description:\s*(.+)/);
                const specMatch = block.match(/Sample Specification:\s*\S+\s+(\d+)ch\s+(\d+)Hz/);
                if (!nameMatch) continue;
                const name = nameMatch[1].trim();
                if (name.startsWith(MR_PW_PREFIX)) continue; // skip our own modules
                devices.push({
                    id: 0,
                    name,
                    description: descMatch?.[1]?.trim() ?? name,
                    direction: 'sink',
                    channels: specMatch?.[1] ? parseInt(specMatch[1], 10) || undefined : undefined,
                    sampleRate: specMatch?.[2]
                        ? parseInt(specMatch[2], 10) || undefined
                        : undefined,
                });
            }
        } catch (err) {
            log.warn({ err }, 'Failed to list devices');
        }

        return devices;
    }

    /**
     * Get device info (channels, sampleRate) for a specific source or sink.
     */
    getDeviceInfo(deviceName: string): { channels: number; sampleRate: number } | null {
        const devices = this.listDevices();
        const dev = devices.find((d) => d.name === deviceName);
        if (dev?.channels && dev?.sampleRate) {
            return { channels: dev.channels, sampleRate: dev.sampleRate };
        }
        return null;
    }
}
