import type { DashboardScript } from './script.js';
import { runScript, ScriptError, type RunState, type ScriptEnv } from './scriptRun.js';

// Runs by button: one at a time each, their state for viewers (ADR-0027).

/** A button's run key: `<scope>/<dashboard>/<widget>`, scope `_` for the server's own dashboards. */
export const runKey = (scope: string, dashboardId: string, widgetId: string): string => `${scope}/${dashboardId}/${widgetId}`;

/** `run` / `stop` arguments: the button, and `confirm` for a reboot without a manager; undefined when malformed. */
export function runArgs(raw: unknown): { widget: string; confirm: boolean } | undefined {
    const a = (raw ?? {}) as { widget?: unknown; confirm?: unknown };
    return typeof a.widget === 'string' ? { widget: a.widget, confirm: a.confirm === true } : undefined;
}

/**
 * The runs on one server: one per button at a time, each stoppable; `onChange`
 * publishes the state for viewers.
 */
export class ScriptRuns {
    private readonly active = new Map<string, AbortController>();
    private readonly states = new Map<string, RunState>();

    constructor(
        private readonly onChange: (key: string, state: RunState) => void,
        private readonly now: () => number = Date.now,
        private readonly log?: (key: string, state: RunState) => void,
    ) {}

    isRunning(key: string): boolean {
        return this.active.has(key);
    }

    state(key: string): RunState | undefined {
        return this.states.get(key);
    }

    /** Start a run; false when this button is already running. */
    start(key: string, script: DashboardScript, env: ScriptEnv): boolean {
        if (this.active.has(key)) return false;
        const ctrl = new AbortController();
        this.active.set(key, ctrl);
        const of = script.steps.length;
        const set = (s: Omit<RunState, 'at'>) => {
            const state = { ...s, at: this.now() };
            this.states.set(key, state);
            this.onChange(key, state);
            if (s.state !== 'running' || s.step <= 1) this.log?.(key, state);
        };
        set({ state: 'running', step: 0, of });
        let current = 0;
        runScript(script, env, {
            signal: ctrl.signal,
            onStep: (step) => {
                current = step;
                set({ state: 'running', step, of });
            },
        })
            .then(() => set({ state: 'done', step: current, of }))
            .catch((err: unknown) => {
                const e = err instanceof ScriptError ? err : new ScriptError(String(err));
                if (ctrl.signal.aborted) set({ state: 'stopped', step: e.step ?? current, of });
                else set({ state: 'failed', step: e.step ?? current, of, error: e.message });
            })
            .finally(() => this.active.delete(key));
        return true;
    }

    /** Stop a run; false when nothing runs. */
    stop(key: string): boolean {
        const ctrl = this.active.get(key);
        ctrl?.abort();
        return !!ctrl;
    }

    stopAll(): void {
        for (const c of this.active.values()) c.abort();
    }

    /** Every run's last state, keyed by `key` split on '/', for the tree. */
    tree(): Record<string, unknown> {
        const out: Record<string, any> = {};
        for (const [key, st] of this.states) {
            const parts = key.split('/');
            let node = out;
            for (const p of parts.slice(0, -1)) node = node[p] ??= {};
            node[parts.at(-1)!] = st;
        }
        return out;
    }
}

/** A sleep that ends early on abort. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done);
    });
}
