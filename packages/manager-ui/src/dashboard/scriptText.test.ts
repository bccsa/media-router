import { describe, it, expect } from 'vitest';
import { actionFromStep, actionKind, scriptSummary, stepFromAction, stepText } from './scriptText';

describe('button scripts in words', () => {
    it('summarises a list for the confirm popup', () => {
        expect(
            scriptSummary({
                
                steps: [
                    { do: 'call', path: '/modules/chat-in', method: 'restart' },
                    { do: 'wait', seconds: { lit: 2 } },
                    { do: 'write', path: '/modules/m1/settings/volume', value: { lit: 80 } },
                    { do: 'write', path: '/info/running', value: { lit: false } },
                ],
            }),
        ).toBe('Runs 4 actions: restart chat-in, wait 2 s, set volume to 80, stop the router.');
        expect(scriptSummary({ steps: [{ do: 'stop' }], timeoutS: 30 })).toBe('Runs a script of 1 block, up to 30 s.');
    });

    it('describes logic blocks and expressions', () => {
        expect(stepText({ do: 'if', cond: { op: '>', a: { read: '/modules/m1/statusData/stats/rtt' }, b: { lit: 50 } }, then: [] })).toBe('if rtt > 50');
        expect(stepText({ do: 'until', cond: { not: { read: '/x/enabled' } }, body: [] })).toBe('repeat until not enabled');
    });

    it("a button's older single action round-trips as a list step", () => {
        const a = { kind: 'write' as const, path: '/modules/m1/settings/audioEnabled', value: false };
        expect(actionFromStep(stepFromAction(a))).toEqual(a);
        expect(actionFromStep({ do: 'wait', seconds: { lit: 1 } })).toBeUndefined();
    });

    it('names a single action as the picker offers it', () => {
        expect(actionKind(undefined)).toBeUndefined();
        expect(actionKind({ kind: 'call', path: '/modules/m1', method: 'restart' })).toBe('restart');
        expect(actionKind({ kind: 'call', path: '/', method: 'reset' })).toBe('reset');
        expect(actionKind({ kind: 'write', path: '/info/running', value: false })).toBe('stop');
        expect(actionKind({ kind: 'write', path: '/info/running', value: true })).toBe('start');
        expect(actionKind({ kind: 'write', path: '/modules/m1/settings/volume', value: 3 })).toBe('set');
    });
});

