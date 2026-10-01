import { lastSegment } from './paths';
import type { DashboardAction, DashboardScript, ScriptExpr, ScriptStep } from '@media-router/shared-types';

// Button scripts in words (ADR-0027): the confirm popup's summary and the editor's rows.

const last = (p: string) => lastSegment(p) ?? p;

export function exprText(e: ScriptExpr): string {
    if ('lit' in e) return typeof e.lit === 'boolean' ? (e.lit ? 'on' : 'off') : String(e.lit);
    if ('read' in e) return last(e.read);
    if ('not' in e) return `not ${exprText(e.not)}`;
    return `${exprText(e.a)} ${e.op} ${exprText(e.b)}`;
}

export function stepText(s: ScriptStep): string {
    switch (s.do) {
        case 'call':
            return s.method === 'restart' ? `restart ${last(s.path)}` : s.method === 'reset' ? 'reset the router' : 'reboot the router';
        case 'write':
            if (s.path.endsWith('/info/running') && 'lit' in s.value) return s.value.lit === true ? 'start the router' : 'stop the router';
            return `set ${last(s.path)} to ${exprText(s.value)}`;
        case 'wait':
            return `wait ${exprText(s.seconds)} s`;
        case 'if':
            return `if ${exprText(s.cond)}`;
        case 'repeat':
            return `repeat ${exprText(s.times)} times`;
        case 'until':
            return `repeat until ${exprText(s.cond)}`;
        case 'waitUntil':
            return `wait until ${exprText(s.cond)}`;
        case 'stop':
            return 'stop';
    }
}

/** For the confirm popup: what pressing will do. */
export function scriptSummary(script: DashboardScript): string {
    const n = script.steps.length;
    const plain = script.steps.every((s) => s.do === 'call' || s.do === 'wait' || (s.do === 'write' && 'lit' in s.value));
    if (!plain) return `Runs a script of ${n} block${n === 1 ? '' : 's'}, up to ${script.timeoutS ?? 60} s.`;
    const steps = script.steps.map(stepText);
    return `Runs ${steps.length === 1 ? '1 action' : `${steps.length} actions`}: ${steps.join(', ')}.`;
}

/** A single action (the button's older form) as a list step, and back. */
export function stepFromAction(a: DashboardAction): ScriptStep {
    return a.kind === 'call'
        ? { do: 'call', path: a.path, method: a.method as 'restart' | 'reset' | 'reboot' }
        : { do: 'write', path: a.path, value: { lit: a.value as number | string | boolean } };
}

export function actionFromStep(s: ScriptStep): DashboardAction | undefined {
    if (s.do === 'call') return { kind: 'call', path: s.path, method: s.method };
    if (s.do === 'write' && 'lit' in s.value) return { kind: 'write', path: s.path, value: s.value.lit };
    return undefined;
}

/** What a single action is, as the action picker offers it. */
export function actionKind(a: DashboardAction | undefined): 'restart' | 'reset' | 'reboot' | 'start' | 'stop' | 'set' | undefined {
    if (!a) return undefined;
    if (a.kind === 'call') return a.method === 'reboot' || a.method === 'reset' ? a.method : 'restart';
    if (a.path.endsWith('/info/running')) return a.value === true ? 'start' : 'stop';
    return 'set';
}

