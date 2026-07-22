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
     * Ordering rules:
     *  - Flag set *before* awaiting `startAll` so a concurrent patch handler
     *    reading `isRunning` mid-flight sees the new intent and doesn't drop
     *    a freshly-added module on the floor.
     *  - `onChange` fires immediately with the flag — it broadcasts run
     *    *intent*, not completion. Everything else already reports intent
     *    (the LCP init payload, the manager's `engine:running` which fires
     *    on click); broadcasting only after startAll completed left the LCP
     *    button lagging a manager-initiated start by the whole pipeline
     *    bring-up (10-20s of connection application + bus-consumer
     *    restarts), while manager browsers updated instantly.
     *  - **On throw, roll the flag back to `false` and broadcast the
     *    rollback.** The flag is reported to the manager via the
     *    `engineRunningState` handshake on every reconnect;
     *    `EngineEventForwarder` interprets `engine.running=true` as
     *    "already running, just push config" and skips the `start`
     *    command. If we left the flag at `true` after a failed startAll,
     *    the engine would be permanently locked out of retries (manager
     *    sees claim, doesn't send start; engine never re-attempts) with
     *    zero modules actually running. Better to drop the claim, let the
     *    manager re-issue `start` on the next reconnect, and re-attempt
     *    startAll from a clean slate.
     */
    async start(): Promise<void> {
        this._running = true;
        this.onChange(true);
        try {
            await this.lifecycle.startAll();
        } catch (err) {
            this._running = false;
            this.onChange(false);
            throw err;
        }
    }

    /**
     * Stop all modules. Same split as `start`: flag clears and broadcasts
     * first (so a clone-during-stop in the await window won't auto-start,
     * and the LCP flips in the same beat as the manager). A stopAll throw
     * keeps the stopped intent — the broadcast already matches it.
     */
    async stop(): Promise<void> {
        this._running = false;
        this.onChange(false);
        await this.lifecycle.stopAll();
        log.debug('Modules stopped');
    }
}
