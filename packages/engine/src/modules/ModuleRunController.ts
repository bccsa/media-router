import { createLogger } from '@media-router/shared-types';
import type { ModuleLifecycle } from './ModuleLifecycle.js';

const log = createLogger('ModuleRunController');

/**
 * Single source of truth for the user-facing "are modules running?" intent.
 *
 * Every caller that wants to start, stop, or query module run state goes
 * through here:
 *  - manager command dispatcher (`start` / `stop` commands)
 *  - local API server (`POST /api/v1/engine/{start,stop,restart}`)
 *  - engine reset flow (decides whether to restart after PipeWire bounce)
 *  - patch router (gates auto-start of freshly-added modules)
 *  - manager-connect handshake (`engineRunningState` payload)
 *
 * Centralising means the intent flag, lifecycle calls, and downstream
 * broadcasts can never drift across callers — historically `moduleManager.size
 * > 0` was used as a proxy in three different places, and `stopAll` leaving
 * dormant instances in the map made it lie.
 */
export class ModuleRunController {
    private _running = false;

    constructor(
        private lifecycle: ModuleLifecycle,
        /** Fired after each transition — wire to LCP broadcast etc. */
        private onChange: (running: boolean) => void,
    ) {}

    get isRunning(): boolean {
        return this._running;
    }

    /**
     * Start all modules.
     *
     * Two ordering rules:
     *  - Flag set *before* awaiting `startAll` so a concurrent patch handler
     *    reading `isRunning` mid-flight sees the new intent and doesn't drop
     *    a freshly-added module on the floor.
     *  - `onChange` fires only on success. The flag tracks user intent (will
     *    survive a failed startAll so the next retry/reset still knows what
     *    the user asked for), but the broadcast tracks observable state — if
     *    startAll threw, modules aren't actually running and we shouldn't tell
     *    the LCP otherwise.
     */
    async start(): Promise<void> {
        this._running = true;
        await this.lifecycle.startAll();
        this.onChange(true);
    }

    /**
     * Stop all modules. Same split as `start`: flag clears first (so a
     * clone-during-stop in the await window won't auto-start), broadcast
     * fires only on a clean stop.
     */
    async stop(): Promise<void> {
        this._running = false;
        await this.lifecycle.stopAll();
        this.onChange(false);
        log.debug('Modules stopped');
    }
}
