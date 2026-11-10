import { describe, it, expect, vi } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import type { PipelineDescription } from './PluginModule.js';
import {
    busOrigins,
    drainGroups,
    DrainGroupLoop,
    type DrainEdge,
    type DrainMember,
    type DrainMemberRef,
} from './drainGroups.js';

// A/V groups by common origin (WI-P4-18, B-179, design 7.1 and the r3 review's carries).
const TS = 'muxed/mpegts';
const A302 = 'audio/302m';
const PCM = 'audio/pcm';
const e = (sourceModuleId: string, sinkModuleId: string, streamType = TS): DrainEdge => ({
    sourceModuleId,
    sinkModuleId,
    streamType,
});
const video = (id: string): DrainMemberRef => ({ id, anchor: true });
const audio = (id: string): DrainMemberRef => ({ id, anchor: false });
const sorted = (groups: string[][]): string[][] => groups.map((g) => [...g].sort()).sort();

describe('busOrigins', () => {
    it('walks bus edges only; a PipeWire edge starts an origin of its own', () => {
        const edges = [e('gate', 'tx'), e('tx', 'vp'), e('gate', 'dec', TS), e('dec', 'aout', PCM)];
        expect([...busOrigins('vp', edges)]).toEqual(['gate']);
        // The plain output after a PipeWire link: its bus walk starts at itself, no origin.
        expect([...busOrigins('aout', edges)]).toEqual([]);
        expect([...busOrigins('dec', edges)]).toEqual(['gate']);
    });

    it('ends at a cycle: a walk that finds no module without a bus input has no origin (M19)', () => {
        const edges = [e('a', 'b'), e('b', 'a'), e('a', 'vp')];
        expect(busOrigins('vp', edges).size).toBe(0);
    });
});

describe('drainGroups', () => {
    it("a translation station is one group: the gate's video, and its audio through a transcoder and a 302M mixer that also takes a mic", () => {
        const edges = [
            e('gate', 'vp'),
            e('gate', 'atx'),
            e('atx', 'mix', A302),
            e('mic', 'mix', A302),
            e('mix', 'out302', A302),
        ];
        const g = drainGroups([video('vp'), audio('out302')], edges);
        expect(sorted(g.groups)).toEqual([['out302', 'vp']]);
        expect(g.neither.size).toBe(0);
    });

    it('a mixer of the gate and a mic over PipeWire joins the gate group too (M20)', () => {
        const edges = [
            e('gate', 'vp'),
            e('gate', 'mix', A302),
            e('capture', 'mix', PCM),
            e('mix', 'out', A302),
        ];
        expect(sorted(drainGroups([video('vp'), audio('out')], edges).groups)).toEqual([
            ['out', 'vp'],
        ]);
    });

    it('an audio-only component forms no group', () => {
        const edges = [e('ingest', 'dec'), e('ingest', 'out302', A302)];
        expect(drainGroups([audio('dec'), audio('out302')], edges).groups).toEqual([]);
    });

    it('two unrelated ingests give two groups', () => {
        const edges = [e('g1', 'v1'), e('g1', 'd1'), e('g2', 'v2'), e('g2', 'd2')];
        const g = drainGroups([video('v1'), audio('d1'), video('v2'), audio('d2')], edges);
        expect(sorted(g.groups)).toEqual([
            ['d1', 'v1'],
            ['d2', 'v2'],
        ]);
    });

    it('a mixer fed from two stations that each have a video joins neither; the groups stay apart (M20)', () => {
        const edges = [
            e('g1', 'v1'),
            e('g1', 'd1'),
            e('g2', 'v2'),
            e('g2', 'd2'),
            e('g1', 'mix'),
            e('g2', 'mix'),
        ];
        const members = [video('v1'), audio('d1'), video('v2'), audio('d2'), audio('mix')];
        const g = drainGroups(members, edges);
        expect(sorted(g.groups)).toEqual([
            ['d1', 'v1'],
            ['d2', 'v2'],
        ]);
        expect(g.neither.get('mix')?.sort()).toEqual(['v1', 'v2']);
    });

    it("a Video Player of two origins never chains two programmes' groups (the r3 carry)", () => {
        // A muxer of gate 1's video and gate 2's audio, played on a third display.
        const edges = [
            e('g1', 'v1'),
            e('g1', 'd1'),
            e('g2', 'v2'),
            e('g2', 'd2'),
            e('g1', 'mux'),
            e('g2', 'mux'),
            e('mux', 'v3'),
        ];
        const g = drainGroups(
            [video('v1'), audio('d1'), video('v2'), audio('d2'), video('v3')],
            edges,
        );
        expect(sorted(g.groups)).toEqual([
            ['d1', 'v1'],
            ['d2', 'v2'],
        ]);
        // ... nor one touching one group with an origin of its own, through its other origin.
        const edges2 = [
            e('g1', 'v1'),
            e('g1', 'mux'),
            e('g2', 'mux'),
            e('mux', 'v3'),
            e('g2', 'd2'),
        ];
        const g2 = drainGroups([video('v1'), video('v3'), audio('d2')], edges2);
        expect(sorted(g2.groups)).toEqual([['v1', 'v3']]);
    });

    it('a routing cycle forms no group (M19)', () => {
        const edges = [e('a', 'b'), e('b', 'a'), e('a', 'vp'), e('b', 'dec')];
        expect(drainGroups([video('vp'), audio('dec')], edges).groups).toEqual([]);
    });

    it('two Video Players of one origin, on two displays, are one group', () => {
        const edges = [e('gate', 'v1'), e('gate', 'v2'), e('gate', 'dec')];
        expect(sorted(drainGroups([video('v1'), video('v2'), audio('dec')], edges).groups)).toEqual(
            [['dec', 'v1', 'v2']],
        );
    });
});

/** A member that records what the loop gave it. */
function member(id: string, anchor: boolean, publishedMs?: number) {
    const applied: Array<[number, unknown]> = [];
    const m: DrainMember = {
        id,
        anchor,
        name: id.toUpperCase(),
        ...(publishedMs !== undefined ? { publishedMs } : {}),
        apply: (ns, view) => applied.push([ns, view]),
    };
    return { m, applied };
}

describe('DrainGroupLoop', () => {
    const edges = [
        e('gate', 'vp'),
        e('gate', 'dec'),
        e('gate', 'atx'),
        e('atx', 'out', A302),
        e('other', 'solo'),
    ];

    it('P is the max of the published targets, to every member each refresh; one alone gets 0 once', () => {
        const vp = member('vp', true, 180);
        const dec = member('dec', false, 120);
        const out = member('out', false); // stalled: publishes none, still in its group
        const solo = member('solo', false, 90);
        const loop = new DrainGroupLoop({
            members: () => [vp.m, dec.m, out.m, solo.m],
            edges: () => edges,
            log: vi.fn(),
        });
        loop.tick();
        loop.tick();
        expect(vp.applied).toEqual([
            [180e6, { with: ['DEC', 'OUT'] }],
            [180e6, { with: ['DEC', 'OUT'] }],
        ]);
        expect(out.applied[0][0]).toBe(180e6);
        expect(solo.applied).toEqual([[0, {}]]);
    });

    it('a stop removes a member, a restart adds it back (the group recomputed)', () => {
        let list = [member('vp', true, 100).m, member('dec', false, 140).m];
        const loop = new DrainGroupLoop({ members: () => list, edges: () => edges, log: vi.fn() });
        loop.tick();
        expect(sorted(loop.current().groups)).toEqual([['dec', 'vp']]);
        list = [list[0]];
        loop.tick();
        expect(loop.current().groups).toEqual([]);
        const back = member('dec', false, 60);
        list = [list[0], back.m];
        loop.tick();
        expect(sorted(loop.current().groups)).toEqual([['dec', 'vp']]);
        expect(back.applied).toEqual([[100e6, { with: ['VP'] }]]);
    });

    it('a member of two programmes is logged once and drains alone', () => {
        const log = vi.fn();
        const two = [
            e('g1', 'v1'),
            e('g1', 'd1'),
            e('g2', 'v2'),
            e('g2', 'd2'),
            e('g1', 'mix'),
            e('g2', 'mix'),
        ];
        const mix = member('mix', false, 50);
        const all = [
            member('v1', true, 1).m,
            member('d1', false, 1).m,
            member('v2', true, 1).m,
            member('d2', false, 1).m,
            mix.m,
        ];
        const loop = new DrainGroupLoop({ members: () => all, edges: () => two, log });
        loop.tick();
        loop.tick();
        expect(log).toHaveBeenCalledOnce();
        expect(log.mock.calls[0][0]).toBe('MIX: in sync with neither V1 nor V2: two programmes');
        expect(mix.applied).toEqual([[0, { neither: ['V1', 'V2'] }]]);
    });
});

class Member extends GstPluginBase {
    buildPipeline(): PipelineDescription | null {
        return null;
    }
    drainElementNames(): string[] {
        return ['outasrc'];
    }
}

describe('GstPluginBase.applyLatencyGroupTarget', () => {
    it('sets group-target-ns on the declared drain elements, and the group for the row', async () => {
        const mod = new Member();
        const setProperty = vi.fn(async () => undefined);
        (mod as unknown as { childProcess: unknown }).childProcess = {
            isRunning: true,
            setProperty,
        };
        await mod.applyLatencyGroupTarget(250_400_000.4, { with: ['Video Player'] });
        expect(setProperty).toHaveBeenCalledWith('outasrc', 'group-target-ns', 250_400_000);
    });

    it('a module without drain elements sets nothing', async () => {
        class Plain extends GstPluginBase {
            buildPipeline(): PipelineDescription | null {
                return null;
            }
        }
        const mod = new Plain();
        const setProperty = vi.fn(async () => undefined);
        (mod as unknown as { childProcess: unknown }).childProcess = {
            isRunning: true,
            setProperty,
        };
        await mod.applyLatencyGroupTarget(1e9);
        expect(setProperty).not.toHaveBeenCalled();
        expect(mod.drainElementNames()).toEqual([]);
        expect(mod.isLatencyGroupAnchor()).toBe(false);
    });
});
