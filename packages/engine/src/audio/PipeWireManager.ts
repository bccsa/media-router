import { createLogger } from '@media-router/shared-types';
import { PaCommandQueue } from './PaCommandQueue.js';
import {
    pwLink as _pwLink,
    pwUnlink as _pwUnlink,
    pwUnlinkByName as _pwUnlinkByName,
    pwUnlinkAllBetween as _pwUnlinkAllBetween,
    listPorts as _listPorts,
    getLinks as _getLinks,
} from './PwLinkOps.js';
import { AudioDeviceOps, type AudioDeviceListing } from './AudioDeviceOps.js';
import { SinkVolumeNormalizer } from './SinkVolumeNormalizer.js';

const log = createLogger('PipeWireManager');

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Prefix for all Media Router PipeWire/PulseAudio modules. */
export const MR_PW_PREFIX = 'MR_PW_';

export interface AudioDevice {
    id: number;
    name: string;
    description: string;
    direction: 'source' | 'sink';
    channels?: number;
    sampleRate?: number;
    /** Raw per-channel volumes (`PA_VOLUME_NORM` = 65536 = unity). Empty when
     *  pactl reported no volume line for the device. */
    volumes?: number[];
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
    private sinkVolumes: SinkVolumeNormalizer;
    /** Ownership tracking: ownerId → the PA modules it loaded, by ID, with the node each names. */
    private ownership = new Map<string, Map<number, string>>();

    constructor(paQueue?: PaCommandQueue) {
        this.paQueue = paQueue ?? new PaCommandQueue();
        this.deviceOps = new AudioDeviceOps(this.paQueue);
        this.sinkVolumes = new SinkVolumeNormalizer(this.paQueue);
    }

    /** Track a PA module ID (and the node it names) as owned by a specific owner. */
    private trackOwnership(ownerId: string, moduleId: number, name: string): void {
        let owned = this.ownership.get(ownerId);
        if (!owned) {
            owned = new Map();
            this.ownership.set(ownerId, owned);
        }
        owned.set(moduleId, name);
    }

    /**
     * Release all PipeWire resources owned by a specific module.
     * Called automatically when a module stops — plugins don't need manual cleanup.
     */
    async releaseAll(ownerId: string): Promise<void> {
        const owned = this.ownership.get(ownerId);
        if (!owned || owned.size === 0) return;
        const entries = [...owned];
        for (const [moduleId, name] of entries) {
            await this.unloadModule(moduleId, name);
        }
        this.ownership.delete(ownerId);
        log.info({ ownerId, count: entries.length }, 'Released all PipeWire resources');
    }

    // --- Null-sink lifecycle ---

    /**
     * Create a named null-sink for a module.
     * Returns the PulseAudio module ID (used for unloading).
     */
    async loadNullSink(
        name: string,
        channels = 2,
        rate = 48000,
        ownerId?: string,
    ): Promise<number> {
        const sinkName = `${MR_PW_PREFIX}${name}`;
        const output = await this.paQueue.exec([
            'load-module',
            'module-null-sink',
            `sink_name=${sinkName}`,
            `rate=${rate}`,
            `channels=${channels}`,
            `sink_properties=device.description='${sinkName}'`,
        ]);
        const moduleId = parseInt(output, 10);
        if (isNaN(moduleId)) {
            throw new Error(`Failed to parse module ID from: ${output}`);
        }
        if (ownerId) this.trackOwnership(ownerId, moduleId, sinkName);
        log.info({ sinkName, moduleId }, 'Created null-sink');
        return moduleId;
    }

    /**
     * Create a PipeWire remap-source from a hardware source.
     * No GStreamer in the audio path — PipeWire handles remapping natively.
     */
    async loadRemapSource(
        name: string,
        master: string,
        channels = 2,
        rate = 48000,
        ownerId?: string,
    ): Promise<number> {
        const sourceName = `${MR_PW_PREFIX}${name}`;
        const output = await this.paQueue.exec([
            'load-module',
            'module-remap-source',
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
        if (ownerId) this.trackOwnership(ownerId, moduleId, sourceName);
        log.info({ sourceName, master, moduleId }, 'Created remap-source');
        return moduleId;
    }

    /**
     * Create a PipeWire remap-sink mapping to a hardware sink.
     * No GStreamer in the audio path — PipeWire handles remapping natively.
     */
    async loadRemapSink(
        name: string,
        master: string,
        channels = 2,
        rate = 48000,
        ownerId?: string,
    ): Promise<number> {
        const sinkName = `${MR_PW_PREFIX}${name}`;
        const output = await this.paQueue.exec([
            'load-module',
            'module-remap-sink',
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
        if (ownerId) this.trackOwnership(ownerId, moduleId, sinkName);
        log.info({ sinkName, master, moduleId }, 'Created remap-sink');
        return moduleId;
    }

    /**
     * Unload a PulseAudio module by ID. With `name` (the node it was loaded as), only while that
     * ID still names it: a pipewire-pulse restart drops every module and hands the same IDs to
     * the next loads, so a stale ID can be another module's fresh one (B-195).
     */
    async unloadModule(moduleId: number, name?: string): Promise<void> {
        const loaded = name === undefined ? true : await this.stillLoadedAs(moduleId, name);
        if (loaded === false) return;
        try {
            await this.paQueue.exec(['unload-module', String(moduleId)]);
            log.info({ moduleId }, 'Unloaded module');
        } catch (err) {
            // Ignore "No such entity" — module already unloaded (e.g. by orphan cleanup)
            const msg = err instanceof Error ? err.message : '';
            if (msg.includes('No such entity')) return;
            // Neither the listing nor the unload got an answer: PipeWire is gone, its modules too.
            if (loaded === null) {
                log.info(
                    { moduleId, node: name, err: msg },
                    'PA module not unloaded: PipeWire does not answer',
                );
            } else {
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
                const output = await this.paQueue.execImmediateAsync(['list', 'short', 'sinks']);
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
                const output = await this.paQueue.execImmediateAsync(['list', 'short', 'sources']);
                if (output.includes(sourceName)) return true;
            } catch {
                /* retry */
            }
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
            'load-module',
            'module-loopback',
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
        if (ownerId) this.trackOwnership(ownerId, moduleId, loopbackName);
        log.info({ source, sink, moduleId }, 'Created loopback');
        return moduleId;
    }

    /** Is PA module `moduleId` loaded with `name` among its arguments (`sink_name=<name>`, ...)?
     *  Null when the listing gets no answer: unloaded anyway, a hiccup must not keep it (B-195). */
    private async stillLoadedAs(moduleId: number, name: string): Promise<boolean | null> {
        let modules: string;
        try {
            modules = await this.paQueue.execImmediateAsync(['list', 'short', 'modules']);
        } catch {
            return null;
        }
        const line = modules.split('\n').find((l) => l.split('\t')[0] === String(moduleId));
        const named = !!line && new RegExp(`=${escapeRegExp(name)}(\\s|$)`).test(line);
        if (!named) {
            // `node`, not `name`: that key is the logger's own (the component).
            log.info(
                { moduleId, node: name },
                'PA module is gone or no longer ours (PipeWire restarted) — not unloaded',
            );
        }
        return named;
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
            const output = await this.paQueue.execImmediateAsync(['list', 'short', 'modules']);
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

    /**
     * Hold hardware sinks at unity gain — call with a fresh `deviceListing()`
     * result, never a stale one (the device-provider poll does this). Fire-and-forget.
     */
    normalizeSinkVolumes(devices: AudioDevice[]): void {
        this.sinkVolumes.normalize(devices);
    }

    // --- Device enumeration (delegated to AudioDeviceOps) ---

    // Asked without blocking: a hung PipeWire must not stall the engine (B-200). Without its answer
    // the listing is its last one, marked stale, and a device unknown, never gone (B-207).
    deviceListing(): Promise<AudioDeviceListing> {
        return this.deviceOps.deviceListing();
    }

    /** Is the device listed? Null while PipeWire gives no answer (unknown). */
    hasDevice(deviceName: string): Promise<boolean | null> {
        return this.deviceOps.hasDevice(deviceName);
    }

    /** The PipeWire daemon's identity: changes when PipeWire restarts; null while unknown. */
    daemonInstance(): Promise<string | null> {
        return this.deviceOps.daemonInstance();
    }

    /** False while the device listing gets no answer: it is then PipeWire's last one, stale. */
    isAvailable(): boolean {
        return this.deviceOps.isAvailable();
    }

    getDeviceInfo(deviceName: string): Promise<{ channels?: number; sampleRate?: number } | null> {
        return this.deviceOps.getDeviceInfo(deviceName);
    }

    // --- Links (delegated to PwLinkOps) ---

    async getLinks(): Promise<Array<{ output: string; input: string }>> {
        return _getLinks();
    }
}
