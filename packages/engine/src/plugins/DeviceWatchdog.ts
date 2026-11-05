import type { ModuleHealth } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import {
    PIPEWIRE_NOT_ANSWERING,
    PIPEWIRE_RESTARTED,
    REBUILD_STABLE_MS,
    lossWarning,
    rebuildDelayMs,
} from './pipeWireLoss.js';

/**
 * Minimal PipeWire surface the watchdog needs. Kept narrow so tests can pass
 * a `{ hasDevice: () => boolean }` stub without the full PipeWireManager.
 */
export interface DeviceWatchdogPipeWire {
    /** Is the device listed? Asked without blocking (B-200); stubs may answer at once. Null:
     *  PipeWire gives no answer, so the device is unknown, never gone (B-207). */
    hasDevice(name: string): Promise<boolean | null> | boolean | null;
    /** The PipeWire daemon's identity: changes when PipeWire restarts; null while unknown. */
    daemonInstance?(): Promise<string | null> | string | null;
    /** False while PipeWire does not answer: the device list is then unknown, not empty. */
    isAvailable?(): boolean;
}

export interface DeviceWatchdogOptions {
    /** Returns the PipeWire device name to watch. Return `null` to keep the watchdog inert for this tick. */
    getDeviceName: () => string | null;
    /** Source of truth for device presence. */
    pipeWire: DeviceWatchdogPipeWire;
    /** Logger for swallowed hook failures and lost streams. Default: a module-level one. */
    log?: ReturnType<typeof createLogger>;
    /** Called once on the connected→disconnected transition (an unplug or a lost stream). */
    onDisconnect: () => Promise<void> | void;
    /** Called once on the disconnected→connected transition. Throw to keep the watchdog in "pending reconnect" state. */
    onReconnect: () => Promise<void> | void;
    /** Notify health change. Called on every state transition. */
    onHealthChange: (health: ModuleHealth, message?: string) => void;
    /** Optional: clear meter data on disconnect (e.g. zero the VU). */
    onClear?: () => void;
    /** Poll interval in ms. Default 2000. */
    pollMs?: number;
}

/**
 * Generic hardware-presence watchdog. Extracted from `GstPluginBase` so any
 * plugin — GStreamer-based or not — can opt into hot-plug detection by
 * instantiating one and wiring its callbacks.
 *
 * State machine: starts in `initiallyConnected` (default true). Each tick
 * asks `pipeWire.hasDevice(getDeviceName())`. On a connected→disconnected
 * transition: emits health=error, calls `onClear`, awaits `onDisconnect`.
 * On a disconnected→connected transition: awaits `onReconnect`, then emits
 * health=ok. If `onReconnect` throws, health flips to `warning` and the
 * `connected` flag stays false so the next tick retries.
 *
 * A lost PipeWire stream goes the same way (B-195): another daemon than the streams'
 * at a tick, or `lose()` (a failed or silent stream), tears down with a warning naming
 * the cause; a later tick rebuilds, backing off (`rebuildDelayMs`).
 *
 * Concurrency: overlapping ticks are skipped (`checkInFlight` guard) so a
 * slow PipeWire query or a long `onReconnect` doesn't pile up concurrent
 * work; `lose()` queues behind an in-flight tick. `stop()` awaits it — important
 * because a tick that's mid-`onReconnect` might still be about to call
 * `loadRemap*`, and the caller's teardown needs that ownership registered
 * before its `releaseAll`.
 */
export class DeviceWatchdog {
    private readonly opts: DeviceWatchdogOptions;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly pollMs: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private connected = true;
    private checkInFlight: Promise<void> | null = null;
    /** The PipeWire daemon the module's streams were built on (null: not known yet). */
    private instance: string | null = null;
    /** The open loss: its cause and the earliest rebuild. */
    private loss: { cause: string; notBefore: number } | null = null;
    /** Losses in the current run, and when the last rebuild finished. */
    private losses = 0;
    private rebuiltAt = 0;

    constructor(opts: DeviceWatchdogOptions) {
        this.opts = opts;
        this.log = opts.log ?? createLogger('DeviceWatchdog');
        this.pollMs = opts.pollMs ?? 2000;
    }

    /** Start polling. Pass `initiallyConnected=false` when the device was missing at start time. */
    start(initiallyConnected = true): void {
        if (this.timer) return;
        this.connected = initiallyConnected;
        if (initiallyConnected) void this.adopt();
        this.timer = setInterval(() => {
            if (this.checkInFlight) return;
            void this.serialize(() => this.check());
        }, this.pollMs);
    }

    /** Stop polling and await any in-flight tick — see class docstring. */
    async stop(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.checkInFlight) {
            await this.checkInFlight;
        }
    }

    /** Current connected/disconnected state. Exposed for tests. */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Run one check now, queued behind an in-flight one. Lets tests drive
     * transitions deterministically without interleaving fake-timer ticks with
     * the multi-await chains inside the host plugin's `onDeviceReconnected`.
     */
    async tick(): Promise<void> {
        await this.serialize(() => this.check());
    }

    /** The module's streams (re)started on the PipeWire daemon that runs now (PLAYING). */
    adopt(): Promise<void> {
        return this.serialize(async () => {
            this.instance = (await this.daemon()) ?? this.instance;
        });
    }

    /** The module's PipeWire stream died (`cause`): tear it down now, rebuild it once PipeWire
     *  and the device are back. */
    async lose(cause: string): Promise<void> {
        if (!this.timer) return;
        await this.serialize(async () => {
            if (this.connected && this.timer) await this.disconnectLost(cause);
        });
    }

    /** Queue `op` behind any in-flight tick or loss; a failure is swallowed (next tick retries). */
    private serialize(op: () => Promise<void>): Promise<void> {
        const inner = (this.checkInFlight ?? Promise.resolve()).then(op).catch(() => {
            /* swallowed — next tick retries */
        });
        // Compare against `wrapper`, not `inner` — `p.finally(cb)` returns a *new*
        // promise, so `checkInFlight === inner` would always be false and the slot
        // would leak forever (latent bug in the pre-extraction GstPluginBase watchdog).
        const wrapper: Promise<void> = inner.finally(() => {
            if (this.checkInFlight === wrapper) this.checkInFlight = null;
        });
        this.checkInFlight = wrapper;
        return wrapper;
    }

    private async daemon(): Promise<string | null> {
        return (await this.opts.pipeWire.daemonInstance?.()) ?? null;
    }

    private restarted(current: string | null): boolean {
        return current !== null && this.instance !== null && current !== this.instance;
    }

    private async disconnectLost(cause: string): Promise<void> {
        const pw = this.opts.pipeWire;
        const now = Date.now();
        const named = this.restarted(await this.daemon())
            ? PIPEWIRE_RESTARTED
            : pw.isAvailable?.() === false
              ? PIPEWIRE_NOT_ANSWERING
              : cause;
        this.losses =
            this.rebuiltAt && now - this.rebuiltAt < REBUILD_STABLE_MS ? this.losses + 1 : 1;
        const delayMs = rebuildDelayMs(this.losses);
        this.loss = { cause: named, notBefore: now + delayMs };
        this.connected = false;
        this.log.warn(
            { cause: named, reported: cause, inARow: this.losses, rebuildInMs: delayMs },
            'PipeWire stream lost: rebuilding it once PipeWire and the device are back',
        );
        this.opts.onClear?.();
        try {
            await this.opts.onDisconnect();
        } catch (err) {
            this.log.debug({ err }, 'onDisconnect hook failed');
        }
        // After the teardown, whose stop reports the module stopped: the warning is what stays.
        this.opts.onHealthChange('warning', lossWarning(named, delayMs));
    }

    private async check(): Promise<void> {
        const deviceName = this.opts.getDeviceName();
        if (!deviceName) return;
        const pw = this.opts.pipeWire;
        // Asked together. A listing that waits is no answer yet: this tick changes nothing until
        // it settles, and a timed-out one is unknown, not an unplug (B-200, B-207).
        const listing = Promise.resolve(pw.hasDevice(deviceName)).then((present) => ({
            present,
            answered: present !== null && pw.isAvailable?.() !== false, // this listing's, as it settles
        }));
        const [{ present, answered }, current] = await Promise.all([listing, this.daemon()]);

        if (this.connected) {
            // First: right after a restart the device is often not listed yet, and is no unplug.
            if (this.restarted(current)) return this.disconnectLost(PIPEWIRE_RESTARTED);
            // A list nobody answers is unknown, not an unplug: a dead stream reports itself.
            if (present === false && answered) {
                this.connected = false;
                this.opts.onHealthChange('error', 'Device disconnected');
                this.opts.onClear?.();
                try {
                    await this.opts.onDisconnect();
                } catch (err) {
                    this.log.debug({ err }, 'onDisconnect hook failed');
                }
                return;
            }
            if (current !== null && this.instance === null) this.instance = current;
            return;
        }
        // Waiting: a restart found while down names the cause it turned out to be.
        if (this.loss && this.loss.cause !== PIPEWIRE_RESTARTED && this.restarted(current)) {
            this.loss.cause = PIPEWIRE_RESTARTED;
            const leftMs = Math.max(0, this.loss.notBefore - Date.now());
            this.opts.onHealthChange('warning', lossWarning(PIPEWIRE_RESTARTED, leftMs));
        }
        // Only PipeWire's own answer starts a rebuild, never a list it gave before it stopped.
        if (!present || !answered || (this.loss && Date.now() < this.loss.notBefore)) return;
        // Only flip `connected` after a successful reconnect — a throw
        // leaves it false so the next tick retries (e.g. the device
        // returned but format wasn't probeable yet).
        try {
            await this.opts.onReconnect();
            this.connected = true;
            this.instance = current;
            if (this.loss) {
                this.log.info({ cause: this.loss.cause }, 'PipeWire stream rebuilt');
                this.rebuiltAt = Date.now();
                this.loss = null;
            }
            this.opts.onHealthChange('ok');
        } catch (err) {
            this.opts.onHealthChange(
                'warning',
                `Reconnect pending: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
}
