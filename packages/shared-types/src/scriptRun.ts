import {
    SCRIPT_DEFAULT_TIMEOUT_S,
    SCRIPT_MAX_EXECUTED,
    SCRIPT_MAX_REPEAT,
    type DashboardScript,
    type ScriptExpr,
    type ScriptStep,
} from './script.js';

// The one interpreter for button scripts (ADR-0027): the router and the
// manager run it against their own tree, so every step gets the checks a
// browser write or call gets. Zod-free and I/O-free.

/** What a script can reach: the tree it runs on. */
export interface ScriptEnv {
    read(path: string): unknown;
    /** Resolves when accepted; throws with the reason when refused. */
    write(path: string, value: unknown): Promise<void>;
    call(path: string, method: string): Promise<unknown>;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
    now(): number;
}

export class ScriptError extends Error {
    /** Top-level step (1-based) that failed, when known. */
    constructor(message: string, readonly step?: number) {
        super(message);
    }
}

/** A run's state as viewers see it (`/runs/<scope>/<dashboard>/<widget>`). */
export interface RunState {
    state: 'running' | 'done' | 'failed' | 'stopped';
    /** Top-level step being run (1-based) and how many there are. */
    step: number;
    of: number;
    error?: string;
    at: number;
}

const WAIT_UNTIL_POLL_MS = 250;

function num(v: unknown): number | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : undefined;
}

function truthy(v: unknown): boolean {
    return v === true || (typeof v === 'number' && v !== 0) || (typeof v === 'string' && v !== '' && v !== '0' && v !== 'false');
}

export function evalExpr(e: ScriptExpr, env: Pick<ScriptEnv, 'read'>): unknown {
    if ('lit' in e) return e.lit;
    if ('read' in e) return env.read(e.read);
    if ('not' in e) return !truthy(evalExpr(e.not, env));
    const a = evalExpr(e.a, env);
    if (e.op === 'and') return truthy(a) && truthy(evalExpr(e.b, env));
    if (e.op === 'or') return truthy(a) || truthy(evalExpr(e.b, env));
    const b = evalExpr(e.b, env);
    const na = num(a);
    const nb = num(b);
    const both = na !== undefined && nb !== undefined;
    switch (e.op) {
        case '=':
            return both ? na === nb : String(a) === String(b);
        case '!=':
            return both ? na !== nb : String(a) !== String(b);
        case '<':
        case '>':
        case '<=':
        case '>=': {
            if (!both) throw new ScriptError(`cannot compare ${String(a)} ${e.op} ${String(b)}: not numbers`);
            return e.op === '<' ? na < nb : e.op === '>' ? na > nb : e.op === '<=' ? na <= nb : na >= nb;
        }
        default: {
            if (!both) throw new ScriptError(`cannot compute ${String(a)} ${e.op} ${String(b)}: not numbers`);
            if (e.op === '/' && nb === 0) throw new ScriptError('division by zero');
            return e.op === '+' ? na + nb : e.op === '-' ? na - nb : e.op === '*' ? na * nb : na / nb;
        }
    }
}

class Stop extends Error {}

/**
 * Run a script to the end, the first failure, a Stop block, `signal`, or its
 * time limit. `onStep(n)` reports the top-level step being run.
 */
export async function runScript(
    script: DashboardScript,
    env: ScriptEnv,
    opts: { signal: AbortSignal; onStep?: (step: number) => void; maxExecuted?: number },
): Promise<void> {
    const limitMs = (script.timeoutS ?? SCRIPT_DEFAULT_TIMEOUT_S) * 1000;
    const deadline = env.now() + limitMs;
    const maxExecuted = opts.maxExecuted ?? SCRIPT_MAX_EXECUTED;
    let executed = 0;
    const guard = () => {
        if (opts.signal.aborted) throw new ScriptError('stopped');
        if (env.now() > deadline) throw new ScriptError(`took longer than ${limitMs / 1000} s`);
        if (++executed > maxExecuted) throw new ScriptError(`ran more than ${maxExecuted} steps (a loop that never ends?)`);
    };
    const wait = async (ms: number) => {
        if (env.now() + ms > deadline) throw new ScriptError(`a wait would pass the ${limitMs / 1000} s limit`);
        await env.sleep(ms, opts.signal);
        if (opts.signal.aborted) throw new ScriptError('stopped');
    };
    const number = (e: ScriptExpr, what: string) => {
        const n = num(evalExpr(e, env));
        if (n === undefined) throw new ScriptError(`${what} is not a number`);
        return n;
    };

    async function runList(steps: readonly ScriptStep[]): Promise<void> {
        for (const s of steps) await runStep(s);
    }

    async function runStep(s: ScriptStep): Promise<void> {
        guard();
        switch (s.do) {
            case 'call':
                await env.call(s.path, s.method);
                return;
            case 'write':
                await env.write(s.path, evalExpr(s.value, env));
                return;
            case 'wait': {
                const sec = number(s.seconds, 'the wait');
                if (sec < 0) throw new ScriptError('a wait cannot be negative');
                await wait(sec * 1000);
                return;
            }
            case 'if':
                await runList(truthy(evalExpr(s.cond, env)) ? s.then : (s.else ?? []));
                return;
            case 'repeat': {
                const times = Math.floor(number(s.times, 'the repeat count'));
                if (times > SCRIPT_MAX_REPEAT) throw new ScriptError(`repeat is limited to ${SCRIPT_MAX_REPEAT} times`);
                for (let i = 0; i < times; i++) await runList(s.body);
                return;
            }
            case 'until':
                while (!truthy(evalExpr(s.cond, env))) {
                    await runList(s.body);
                    guard();
                }
                return;
            case 'waitUntil': {
                const giveUp = env.now() + s.timeoutS * 1000;
                while (!truthy(evalExpr(s.cond, env))) {
                    if (env.now() >= giveUp) throw new ScriptError(`waited ${s.timeoutS} s and the condition never held`);
                    await wait(Math.min(WAIT_UNTIL_POLL_MS, Math.max(0, giveUp - env.now())));
                }
                return;
            }
            case 'stop':
                throw new Stop();
        }
    }

    for (let i = 0; i < script.steps.length; i++) {
        opts.onStep?.(i + 1);
        try {
            await runStep(script.steps[i]);
        } catch (err) {
            if (err instanceof Stop) return;
            const message = err instanceof Error ? err.message : String(err);
            throw new ScriptError(message, i + 1);
        }
    }
}
