import { describe, it, expect, vi } from 'vitest';
import { evalExpr, runScript, type ScriptEnv } from './scriptRun.js';
import { ScriptRuns } from './scriptRuns.js';
import { DashboardScriptSchema, mapScriptPaths, scriptPaths, type DashboardScript, type ScriptStep } from './dashboard.js';

/** A fake tree: values in a map, virtual time, every write/call recorded. */
function env(values: Record<string, unknown> = {}) {
    let t = 0;
    const log: string[] = [];
    const e: ScriptEnv & { log: string[]; values: Record<string, unknown> } = {
        log,
        values,
        read: (p) => values[p],
        write: async (p, v) => {
            if (p === '/refused') throw new Error('out of range');
            values[p] = v;
            log.push(`write ${p}=${String(v)}`);
        },
        call: async (p, m) => {
            log.push(`call ${p} ${m}`);
        },
        sleep: async (ms) => {
            t += ms;
            log.push(`wait ${ms}`);
        },
        now: () => t,
    };
    return e;
}

const run = (steps: ScriptStep[], e: ScriptEnv, timeoutS?: number, signal = new AbortController().signal) =>
    runScript({ steps, timeoutS }, e, { signal });
const lit = (v: number | string | boolean) => ({ lit: v });

describe('button scripts: a list of actions', () => {
    it('runs actions and waits in order', async () => {
        const e = env();
        await run([{ do: 'call', path: '/modules/m1', method: 'restart' }, { do: 'wait', seconds: lit(2) }, { do: 'write', path: '/modules/m1/settings/volume', value: lit(80) }], e);
        expect(e.log).toEqual(['call /modules/m1 restart', 'wait 2000', 'write /modules/m1/settings/volume=80']);
    });

    it('stops at the first failed step, naming it', async () => {
        const e = env();
        const r = run([{ do: 'write', path: '/a', value: lit(1) }, { do: 'write', path: '/refused', value: lit(2) }, { do: 'write', path: '/b', value: lit(3) }], e);
        await expect(r).rejects.toMatchObject({ message: 'out of range', step: 2 });
        expect(e.log).toEqual(['write /a=1']);
    });
});

describe('button scripts: logic', () => {
    it('if / else on a value read at run time', async () => {
        const e = env({ '/mute': false });
        const toggle: ScriptStep = {
            do: 'if',
            cond: { op: '=', a: { read: '/mute' }, b: lit(true) },
            then: [{ do: 'write', path: '/mute', value: lit(false) }],
            else: [{ do: 'write', path: '/mute', value: lit(true) }],
        };
        await run([toggle], e);
        await run([toggle], e);
        expect(e.log).toEqual(['write /mute=true', 'write /mute=false']);
    });

    it('a fade: repeat with arithmetic on the current value', async () => {
        const e = env({ '/vol': 100 });
        await run([{ do: 'repeat', times: lit(4), body: [{ do: 'write', path: '/vol', value: { op: '-', a: { read: '/vol' }, b: lit(25) } }, { do: 'wait', seconds: lit(0.5) }] }], e);
        expect(e.values['/vol']).toBe(0);
    });

    it('repeat until, and wait until with its own timeout', async () => {
        const e = env({ '/n': 0 });
        await run([{ do: 'until', cond: { op: '>=', a: { read: '/n' }, b: lit(3) }, body: [{ do: 'write', path: '/n', value: { op: '+', a: { read: '/n' }, b: lit(1) } }] }], e);
        expect(e.values['/n']).toBe(3);
        await expect(run([{ do: 'waitUntil', cond: { read: '/never' }, timeoutS: 1 }], e)).rejects.toThrow('never held');
    });

    it('stop ends the run without an error; numbers sent as text compare as numbers', async () => {
        const e = env({ '/rtt': '3.40' });
        await run([{ do: 'if', cond: { op: '>', a: { read: '/rtt' }, b: lit(2) }, then: [{ do: 'stop' }] }, { do: 'write', path: '/x', value: lit(1) }], e);
        expect(e.log).toEqual([]);
        expect(evalExpr({ not: { op: 'and', a: lit(true), b: lit(0) } }, e)).toBe(true);
    });
});

describe('button scripts: limits', () => {
    it('a script cannot run past its time limit', async () => {
        const e = env();
        await expect(run([{ do: 'wait', seconds: lit(61) }], e)).rejects.toThrow('60 s limit');
        await expect(run([{ do: 'wait', seconds: lit(90) }], e, 120)).resolves.toBeUndefined();
    });

    it('a loop that never ends is cut off', async () => {
        const e = env();
        const r = runScript({ steps: [{ do: 'until', cond: lit(false), body: [{ do: 'write', path: '/x', value: lit(1) }] }] }, e, {
            signal: new AbortController().signal,
            maxExecuted: 50,
        });
        await expect(r).rejects.toThrow('never ends');
    });

    it('the schema caps nesting depth and calls, and drops an older mode', () => {
        const parsed = DashboardScriptSchema.safeParse({ mode: 'list', steps: [{ do: 'stop' }] });
        expect(parsed.success && parsed.data).toEqual({ steps: [{ do: 'stop' }] });
        let deep: ScriptStep = { do: 'stop' };
        for (let i = 0; i < 9; i++) deep = { do: 'if', cond: lit(true), then: [deep] };
        expect(DashboardScriptSchema.safeParse({ steps: [deep] }).success).toBe(false);
        expect(DashboardScriptSchema.safeParse({ steps: [{ do: 'call', path: '/', method: 'save' }] }).success).toBe(false);
    });

    it('paths follow a module move, reads included', () => {
        const steps: ScriptStep[] = [{ do: 'if', cond: { read: '/modules/a/enabled' }, then: [{ do: 'write', path: '/modules/a/settings/v', value: { read: '/modules/b/settings/v' } }] }];
        const moved = mapScriptPaths(steps, (p) => p.replace('/modules/a', '/modules/c'));
        expect(scriptPaths(moved)).toEqual(['/modules/c/enabled', '/modules/c/settings/v', '/modules/b/settings/v']);
    });
});

describe('ScriptRuns: one run per button, stoppable, published', () => {
    it('reports progress, refuses a second start, and stops on request', async () => {
        const states: string[] = [];
        const runs = new ScriptRuns((k, s) => states.push(`${k} ${s.state} ${s.step}/${s.of}`));
        let release!: () => void;
        const e: ScriptEnv = {
            ...env(),
            sleep: (_ms, signal) => new Promise<void>((r) => { release = r; signal.addEventListener('abort', () => r()); }),
        };
        const script: DashboardScript = { steps: [{ do: 'write', path: '/a', value: lit(1) }, { do: 'wait', seconds: lit(5) }, { do: 'write', path: '/b', value: lit(2) }] };
        expect(runs.start('_/d1/w1', script, e)).toBe(true);
        expect(runs.start('_/d1/w1', script, e)).toBe(false);
        await vi.waitFor(() => expect(states.at(-1)).toBe('_/d1/w1 running 2/3'));
        expect(runs.stop('_/d1/w1')).toBe(true);
        await vi.waitFor(() => expect(states.at(-1)).toBe('_/d1/w1 stopped 2/3'));
        expect(runs.isRunning('_/d1/w1')).toBe(false);
        expect(runs.tree()).toMatchObject({ _: { d1: { w1: { state: 'stopped' } } } });
        void release;
    });

    it('a failure is published with its reason', async () => {
        const states: Array<{ state: string; error?: string }> = [];
        const runs = new ScriptRuns((_k, s) => states.push(s));
        runs.start('k', { steps: [{ do: 'write', path: '/refused', value: lit(1) }] }, env());
        await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: 'failed', error: 'out of range' }));
    });
});
