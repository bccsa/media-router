import { execFileSync } from 'child_process';
import { createLogger } from '@media-router/shared-types';
import { PaCommandQueue } from './PaCommandQueue.js';

const log = createLogger('PipeWireManager');

/** Prefix for all Media Router PipeWire/PulseAudio modules. */
export const MR_PW_PREFIX = 'MR_PW_';

export interface AudioDevice {
    id: number;
    name: string;
    description: string;
    direction: 'source' | 'sink';
    channels?: number;
    sampleRate?: number;
}

/**
 * PipeWire audio routing manager.
 *
 * Manages named PulseAudio modules (null-sinks, loopbacks) for inter-module
 * audio routing. All mutating commands go through PaCommandQueue for rate limiting.
 *
 * All commands use execFile with argument arrays (no shell) to prevent
 * command injection from untrusted device/module names.
 */
export class PipeWireManager {
    private paQueue: PaCommandQueue;
    /** Ownership tracking: ownerId → Set of PA module IDs */
    private ownership = new Map<string, Set<number>>();

    constructor(paQueue?: PaCommandQueue) {
        this.paQueue = paQueue ?? new PaCommandQueue();
    }

    /** Track a PA module ID as owned by a specific owner. */
    private trackOwnership(ownerId: string, moduleId: number): void {
        let set = this.ownership.get(ownerId);
        if (!set) {
            set = new Set();
            this.ownership.set(ownerId, set);
        }
        set.add(moduleId);
    }

    /** Remove a PA module ID from ownership tracking. */
    private untrackOwnership(ownerId: string, moduleId: number): void {
        const set = this.ownership.get(ownerId);
        if (set) {
            set.delete(moduleId);
            if (set.size === 0) this.ownership.delete(ownerId);
        }
    }

    /**
     * Release all PipeWire resources owned by a specific module.
     * Called automatically when a module stops — plugins don't need manual cleanup.
     */
    async releaseAll(ownerId: string): Promise<void> {
        const set = this.ownership.get(ownerId);
        if (!set || set.size === 0) return;
        const ids = [...set];
        for (const moduleId of ids) {
            await this.unloadModule(moduleId);
        }
        this.ownership.delete(ownerId);
        log.info({ ownerId, count: ids.length }, 'Released all PipeWire resources');
    }

    // --- Null-sink lifecycle ---

    /**
     * Create a named null-sink for a module.
     * Returns the PulseAudio module ID (used for unloading).
     */
    async loadNullSink(name: string, channels = 2, rate = 48000, ownerId?: string): Promise<number> {
        const sinkName = `${MR_PW_PREFIX}${name}`;
        const output = await this.paQueue.exec([
            'load-module', 'module-null-sink',
            `sink_name=${sinkName}`,
            `rate=${rate}`,
            `channels=${channels}`,
            `sink_properties=device.description='${sinkName}'`,
        ]);
        const moduleId = parseInt(output, 10);
        if (isNaN(moduleId)) {
            throw new Error(`Failed to parse module ID from: ${output}`);
        }
        if (ownerId) this.trackOwnership(ownerId, moduleId);
        log.info({ sinkName, moduleId }, 'Created null-sink');
        return moduleId;
    }

    /**
     * Unload a PulseAudio module by ID.
     */
    async unloadModule(moduleId: number): Promise<void> {
        try {
            await this.paQueue.exec(['unload-module', String(moduleId)]);
            log.info({ moduleId }, 'Unloaded module');
        } catch (err) {
            // Ignore "No such entity" — module already unloaded (e.g. by orphan cleanup)
            const msg = err instanceof Error ? err.message : '';
            if (!msg.includes('No such entity')) {
                log.warn({ moduleId, err: msg }, 'Failed to unload module');
            }
        }
    }

    /**
     * Wait until a sink is visible in PipeWire/PulseAudio.
     * Polls `pactl list short sinks` until the sink name appears or timeout.
     * @param sinkName  Full sink name (e.g. MR_PW_audio-input-abc)
     * @param timeoutMs Max wait time (default 2000ms)
     * @param intervalMs Poll interval (default 50ms)
     */
    async waitForSink(sinkName: string, timeoutMs = 2000, intervalMs = 50): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const output = this.paQueue.execImmediate(['list', 'short', 'sinks']);
                if (output.includes(sinkName)) return true;
            } catch {
                // pactl failed — retry
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        log.warn({ sinkName, timeoutMs }, 'Timed out waiting for sink to appear');
        return false;
    }

    // --- Loopback (audio connections) ---

    /**
     * Create a PulseAudio loopback between a source and a sink.
     * Returns the PulseAudio module ID.
     *
     * @param connId  Connection ID (used in loopback_name for identification)
     * @param source  PulseAudio source name (e.g. MR_PW_audio-input-abc.monitor)
     * @param sink    PulseAudio sink name (e.g. MR_PW_audio-output-def)
     */
    async loadLoopback(
        connId: string,
        source: string,
        sink: string,
        channels = 2,
        rate = 48000,
        ownerId?: string,
    ): Promise<number> {
        const loopbackName = `${MR_PW_PREFIX}CONN_${connId}`;
        const output = await this.paQueue.exec([
            'load-module', 'module-loopback',
            `loopback_name=${loopbackName}`,
            `source=${source}`,
            `sink=${sink}`,
            `channels=${channels}`,
            `rate=${rate}`,
            'latency_msec=20',
            'source_dont_move=true',
            'sink_dont_move=true',
        ]);
        const moduleId = parseInt(output, 10);
        if (isNaN(moduleId)) {
            throw new Error(`Failed to parse loopback module ID from: ${output}`);
        }
        if (ownerId) this.trackOwnership(ownerId, moduleId);
        log.info({ source, sink, moduleId }, 'Created loopback');
        return moduleId;
    }

    // --- Cleanup ---

    /**
     * Remove all MR_PW_* modules (orphan cleanup on startup or shutdown).
     */
    async cleanupOrphans(): Promise<void> {
        try {
            const output = this.paQueue.execImmediate(['list', 'short', 'modules']);
            const lines = output.split('\n');
            for (const line of lines) {
                if (!line.includes(MR_PW_PREFIX)) continue;
                const parts = line.split('\t');
                const moduleId = parseInt(parts[0], 10);
                if (!isNaN(moduleId)) {
                    await this.unloadModule(moduleId);
                }
            }
            log.info('Orphan cleanup complete');
        } catch (err) {
            log.warn({ err }, 'Orphan cleanup failed');
        }
    }

    // --- Volume control ---

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

    // --- Device enumeration (read-only, no queue) ---

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
                    channels: specMatch ? parseInt(specMatch[1], 10) : undefined,
                    sampleRate: specMatch ? parseInt(specMatch[2], 10) : undefined,
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
                    channels: specMatch ? parseInt(specMatch[1], 10) : undefined,
                    sampleRate: specMatch ? parseInt(specMatch[2], 10) : undefined,
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

    /**
     * List all active PipeWire links.
     */
    getLinks(): Array<{ output: string; input: string }> {
        try {
            const output = execFileSync('pw-link', ['-l'], {
                encoding: 'utf-8',
                timeout: 5000,
                env: { ...process.env, DISPLAY: '' },
            });
            const links: Array<{ output: string; input: string }> = [];
            let currentOutput = '';

            for (const line of output.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith('|->') || trimmed.startsWith('|<-')) {
                    const linkedPort = trimmed.replace(/^\|[-<>]+\s*/, '');
                    if (currentOutput && linkedPort) {
                        links.push({ output: currentOutput, input: linkedPort });
                    }
                } else if (!trimmed.startsWith('|')) {
                    currentOutput = trimmed;
                }
            }

            return links;
        } catch {
            return [];
        }
    }
}
