import { describe, it, expect } from 'vitest';
import { audioEnabledTargets, groupStates, interlockRepairs, unmuteCascade, withInterlockMutes } from './interlockMutes.js';

const on = (v: boolean) => ({ settings: { audioEnabled: v } });
const path = (id: string) => `/modules/${id}/settings/audioEnabled`;
const set = (id: string, value: boolean) => ({ op: 'replace' as const, path: path(id), value });

describe('interlock mutes', () => {
    const modules = { a: on(true), b: on(false), c: on(true), x: on(true) };
    const interlocks = [{ members: ['a', 'b', 'c'] }];

    it('unmuting a member mutes the other live members, not other groups', () => {
        expect(unmuteCascade(modules, interlocks, 'b')).toEqual([set('a', false), set('c', false)]);
        expect(unmuteCascade(modules, interlocks, 'x')).toEqual([]);
    });

    it('puts each unmute’s mutes before it and follows the batch as it goes', () => {
        const r = withInterlockMutes([set('c', false), set('b', true)], { modules, interlocks });
        expect(r.ops).toEqual([set('c', false), set('a', false), set('b', true)]);
        expect(r.mutes).toEqual([set('a', false)]);
    });

    it('leaves other writes and configs without interlocks alone', () => {
        const ops = [{ op: 'replace' as const, path: '/modules/a/settings/volume', value: 3 }, set('x', true)];
        expect(withInterlockMutes(ops, { modules, interlocks })).toEqual({ ops, mutes: [] });
        expect(withInterlockMutes([set('b', true)], { modules })).toEqual({ ops: [set('b', true)], mutes: [] });
    });

    it('a member the batch sets itself is left to the batch', () => {
        // A repaired config's difference: b muted and c unmuted in one batch.
        const r = withInterlockMutes([set('a', false), set('b', true)], { modules, interlocks });
        expect(r.mutes).toEqual([set('c', false)]);
    });

    it('repairs: the first live member in the group stays', () => {
        expect(interlockRepairs({ modules, interlocks })).toEqual([set('c', false)]);
        expect(interlockRepairs({ modules })).toEqual([]);
    });

    it('reports every member of a touched group as it stands', () => {
        expect(groupStates({ modules, interlocks }, ['c'])).toEqual([set('a', true), set('b', false), set('c', true)]);
        expect(groupStates({ modules, interlocks }, ['x'])).toEqual([]);
        expect(audioEnabledTargets([set('a', true), { op: 'replace', path: '/modules/a/settings/volume', value: 1 }])).toEqual(['a']);
    });
});

