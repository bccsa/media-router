import { createLogger } from '@media-router/shared-types';
import { PaCommandQueue } from './PaCommandQueue.js';
import { pwLink as _pwLink, pwUnlink as _pwUnlink, pwUnlinkByName as _pwUnlinkByName, pwUnlinkAllBetween as _pwUnlinkAllBetween, listPorts as _listPorts, getLinks as _getLinks } from './PwLinkOps.js';
import { AudioDeviceOps } from './AudioDeviceOps.js';

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
    private deviceOps: AudioDeviceOps;
    /** Ownership tracking: ownerId → Set of PA module IDs */
    private ownership = new Map<string, Set<number>>();

    constructor(paQueue?: PaCommandQueue) {
        this.paQueue = paQueue ?? new PaCommandQueue();
        this.deviceOps = new AudioDeviceOps(this.paQueue);
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
     * Create a PipeWire remap-source from a hardware source.
     * No GStreamer in the audio path — PipeWire handles remapping natively.
     */
    async loadRemapSource(name: string, master: string, channels = 2, rate = 48000, ownerId?: string): Promise<number> {
        const sourceName = `${MR_PW_PREFIX}${name}`;
        const output = await this.paQueue.exec([
            'load-module', 'module-remap-source',
            `master=${master}`,
            `source_name=${sourceName}`,
            `channels=${channels}`,
            `rate=${rate}`,
            `source_properties=device.description='${sourceName}'`,
        ]);
        const moduleId = parseInt(output, 10);
        if (isNaN(moduleId)) {
            throw new Error(`Failed to parse remap-source module ID from: ${output}`);
        }
        if (ownerId) this.trackOwnership(ownerId, moduleId);
        log.info({ sourceName, master, moduleId }, 'Created remap-source');
        return moduleId;
    }

    /**
     * Create a PipeWire remap-sink mapping to a hardware sink.
     * No GStreamer in the audio path — PipeWire handles remapping natively.
     */
    async loadRemapSink(name: string, master: string, channels = 2, rate = 48000, ownerId?: string): Promise<number> {
        const sinkName = `${MR_PW_PREFIX}${name}`;
        const output = await this.paQueue.exec([
            'load-module', 'module-remap-sink',
            `master=${master}`,
            `sink_name=${sinkName}`,
            `channels=${channels}`,
            `rate=${rate}`,
            `sink_properties=device.description='${sinkName}'`,
        ]);
        const moduleId = parseInt(output, 10);
        if (isNaN(moduleId)) {
            throw new Error(`Failed to parse remap-sink module ID from: ${output}`);
        }
        if (ownerId) this.trackOwnership(ownerId, moduleId);
        log.info({ sinkName, master, moduleId }, 'Created remap-sink');
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

    /**
     * Wait until a source is visible in PipeWire/PulseAudio.
     * Polls `pactl list short sources` until the source name appears or timeout.
     */
    async waitForSource(sourceName: string, timeoutMs = 2000, intervalMs = 50): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const output = this.paQueue.execImmediate(['list', 'short', 'sources']);
                if (output.includes(sourceName)) return true;
            } catch { /* retry */ }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        log.warn({ sourceName, timeoutMs }, 'Timed out waiting for source to appear');
        return false;
    }

    // --- Loopback (audio connections) ---

    /**
     * Create a PulseAudio loopback between a source and a sink.
     * Returns the PulseAudio module ID.
     */
    async loadLoopback(
        connId: string,
        source: string,
        sink: string,
        channels = 2,
        rate = 48000,
        ownerId?: string,
        latencyMs = 20,
    ): Promise<number> {
        const loopbackName = `${MR_PW_PREFIX}CONN_${connId}`;
        const output = await this.paQueue.exec([
            'load-module', 'module-loopback',
            `loopback_name=${loopbackName}`,
            `source=${source}`,
            `sink=${sink}`,
            `channels=${channels}`,
            `rate=${rate}`,
            `latency_msec=${latencyMs}`,
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

    // --- Port discovery (delegated to PwLinkOps) ---

    async listPorts(node: string, direction: 'input' | 'output'): Promise<string[]> {
        return _listPorts(node, direction);
    }

    // --- pw-link (delegated to PwLinkOps) ---

    async pwLink(outputPort: string, inputPort: string): Promise<number> {
        return _pwLink(outputPort, inputPort);
    }

    async pwUnlink(linkId: number): Promise<void> {
        return _pwUnlink(linkId);
    }

    async pwUnlinkByName(outputPort: string, inputPort: string): Promise<boolean> {
        return _pwUnlinkByName(outputPort, inputPort);
    }

    async pwUnlinkAllBetween(sourceNode: string, sinkNode: string): Promise<void> {
        return _pwUnlinkAllBetween(sourceNode, sinkNode);
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

    // --- Volume control (delegated to AudioDeviceOps) ---

    async setSourceVolume(device: string, percent: number): Promise<void> {
        return this.deviceOps.setSourceVolume(device, percent);
    }

    async setSinkVolume(device: string, percent: number): Promise<void> {
        return this.deviceOps.setSinkVolume(device, percent);
    }

    // --- Device enumeration (delegated to AudioDeviceOps) ---

    listDevices(): AudioDevice[] {
        return this.deviceOps.listDevices();
    }

    getDeviceInfo(deviceName: string): { channels: number; sampleRate: number } | null {
        return this.deviceOps.getDeviceInfo(deviceName);
    }

    // --- Links (delegated to PwLinkOps) ---

    async getLinks(): Promise<Array<{ output: string; input: string }>> {
        return _getLinks();
    }
}
