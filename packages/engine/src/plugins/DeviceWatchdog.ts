import type { ModuleHealth } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';

/**
 * Minimal PipeWire surface the watchdog needs. Kept narrow so tests can pass
 * a `{ hasDevice: () => boolean }` stub without the full PipeWireManager.
 */
export interface DeviceWatchdogPipeWire {
    hasDevice(name: string): boolean;
}

export interface DeviceWatchdogOptions {
    /** Returns the PipeWire device name to watch. Return `null` to keep the watchdog inert for this tick. */
    getDeviceName: () => string | null;
    /** Source of truth for device presence. */
    pipeWire: DeviceWatchdogPipeWire;
    /** Logger used only for swallowed hook failures. Defaults to a module-level logger if omitted. */
    log?: ReturnType<typeof createLogger>;
    /** Called once on the connected→disconnected transition. */
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
 * Concurrency: overlapping ticks are skipped (`checkInFlight` guard) so a
 * slow PipeWire query or a long `onReconnect` doesn't pile up concurrent
 * work. `stop()` awaits any in-flight tick — important because a tick that's
 * mid-`onReconnect` might still be about to call `loadRemap*`, and the
 * caller's teardown needs that ownership registered before its `releaseAll`.
 */
export class DeviceWatchdog {
    private readonly opts: DeviceWatchdogOptions;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly pollMs: number;
    private timer: ReturnType<typeof setInterval> | null = null;
    private connected = true;
    private checkInFlight: Promise<void> | null = null;

    constructor(opts: DeviceWatchdogOptions) {
        this.opts = opts;
        this.log = opts.log ?? createLogger('DeviceWatchdog');
        this.pollMs = opts.pollMs ?? 2000;
    }

    /** Start polling. Pass `initiallyConnected=false` when the device was missing at start time. */
    start(initiallyConnected = true): void {
        if (this.timer) return;
        this.connected = initiallyConnected;
        this.timer = setInterval(() => {
            if (this.checkInFlight) return;
            const inner = this.check().catch(() => {
                /* swallowed — next tick retries */
            });
            // `wrapper` is the value we store in `checkInFlight`. The callback
            // compares against `wrapper`, not `inner` — `p.finally(cb)` returns
            // a *new* promise, so `checkInFlight === inner` would always be
            // false and the slot would leak forever (latent bug in the
            // pre-extraction GstPluginBase watchdog).
            const wrapper: Promise<void> = inner.finally(() => {
                if (this.checkInFlight === wrapper) this.checkInFlight = null;
            });
            this.checkInFlight = wrapper;
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
     * Run one check synchronously (well, async-but-not-on-the-timer).
     * Intended for tests that need to drive transitions deterministically
     * without interleaving fake-timer ticks with the multi-await chains
     * inside the host plugin's `onDeviceReconnected`. Also fine for any
     * caller that wants to force a presence check on demand.
     */
    async tick(): Promise<void> {
        await this.check();
    }

    private async check(): Promise<void> {
        const deviceName = this.opts.getDeviceName();
        if (!deviceName) return;
        const present = this.opts.pipeWire.hasDevice(deviceName);

        if (this.connected && !present) {
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
        if (!this.connected && present) {
            // Only flip `connected` after a successful reconnect — a throw
            // leaves it false so the next tick retries (e.g. the device
            // returned but format wasn't probeable yet).
            try {
                await this.opts.onReconnect();
                this.connected = true;
                this.opts.onHealthChange('ok');
            } catch (err) {
                this.opts.onHealthChange(
                    'warning',
                    `Reconnect pending: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }
}
