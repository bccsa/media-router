import { describe, it, expect, vi } from 'vitest';
import { GstPluginBase } from './GstPluginBase.js';
import type { PipelineDescription } from './PluginModule.js';
import { DRAIN_GROUP_ALONE_NS } from './drainSummary.js';
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

/** p5-20: the receiver's keys, as ModuleManager gives them: a Trust ingest's sender timeline. */
const TL_A = '0123456789abcdef';
const TL_B = 'fedcba9876543210';
const keyed =
    (map: Record<string, string>) =>
    (id: string): string =>
        map[id] ? `tl:${map[id]}` : id;

describe('drainGroups: Trust inputs by their sender timeline (p5-20)', () => {
    // A Video Player on a Trust srt-input, an Audio Output (302M) on a Trust rist-input.
    const av = [e('srt-in', 'vp'), e('rist-in', 'out302', A302)];

    it('(a) one timeline id on both ingests: one group', () => {
        const g = drainGroups(
            [video('vp'), audio('out302')],
            av,
            keyed({ 'srt-in': TL_A, 'rist-in': TL_A }),
        );
        expect(sorted(g.groups)).toEqual([['out302', 'vp']]);
    });

    it('(b) different ids: apart; and without keys, two modules are two origins as before', () => {
        const members = [video('vp'), audio('out302')];
        expect(drainGroups(members, av, keyed({ 'srt-in': TL_A, 'rist-in': TL_B })).groups).toEqual(
            [],
        );
        expect(drainGroups(members, av).groups).toEqual([]);
    });

    it('(d) two unrelated Trust programmes, two players and two audio outputs: two groups, not one per box', () => {
        const edges = [
            e('srt-1', 'v1'),
            e('rist-1', 'a1', A302),
            e('srt-2', 'v2'),
            e('rist-2', 'a2', A302),
        ];
        const g = drainGroups(
            [video('v1'), audio('a1'), video('v2'), audio('a2')],
            edges,
            keyed({ 'srt-1': TL_A, 'rist-1': TL_A, 'srt-2': TL_B, 'rist-2': TL_B }),
        );
        expect(sorted(g.groups)).toEqual([
            ['a1', 'v1'],
            ['a2', 'v2'],
        ]);
    });

    it('(e) a Trust and a Restamp ingest of one programme: apart (their labels differ by k)', () => {
        // The Restamp ingest has no key: its module id, whatever its sender declares.
        const g = drainGroups([video('vp'), audio('out302')], av, keyed({ 'srt-in': TL_A }));
        expect(g.groups).toEqual([]);
    });

    it('(g) the two-origin Video Player rule holds on Trust keys: a player of two programmes chains nothing', () => {
        // A muxer of programme A's video and programme B's audio on a third display.
        const edges = [
            e('srt-1', 'v1'),
            e('rist-1', 'a1', A302),
            e('srt-2', 'v2'),
            e('rist-2', 'a2', A302),
            e('srt-1', 'mux'),
            e('rist-2', 'mux'),
            e('mux', 'v3'),
        ];
        const keys = keyed({ 'srt-1': TL_A, 'rist-1': TL_A, 'srt-2': TL_B, 'rist-2': TL_B });
        const g = drainGroups(
            [video('v1'), audio('a1'), video('v2'), audio('a2'), video('v3')],
            edges,
            keys,
        );
        expect(sorted(g.groups)).toEqual([
            ['a1', 'v1'],
            ['a2', 'v2'],
        ]);
        // An audio output whose two origins are two Trust programmes joins neither.
        const mix = [...edges.slice(0, 4), e('rist-1', 'mix', A302), e('srt-2', 'mix', A302)];
        const g2 = drainGroups(
            [video('v1'), audio('a1'), video('v2'), audio('a2'), audio('mix')],
            mix,
            keys,
        );
        expect(g2.neither.get('mix')?.sort()).toEqual(['v1', 'v2']);
        // Audio-only components are not grouped, Trust or not.
        const only = [e('rist-1', 'a1', A302), e('srt-1', 'dec')];
        expect(
            drainGroups([audio('a1'), audio('dec')], only, keyed({ 'srt-1': TL_A, 'rist-1': TL_A }))
                .groups,
        ).toEqual([]);
    });

    it("(i) the named limit: a sender's {A, V} mux and its {A} egress arrive with two ids and stay apart", () => {
        // The sender hashed {A, V} to one id and {A} to A's own: one 64-bit id cannot say "touches".
        const g = drainGroups(
            [video('vp'), audio('out302')],
            av,
            keyed({ 'srt-in': 'aaaaaaaaaaaaaaaa', 'rist-in': 'bbbbbbbbbbbbbbbb' }),
        );
        expect(g.groups).toEqual([]);
    });

    it('(j) an ingest with timeline_id 0 has no key (its drainOriginKey is undefined): its module id', () => {
        // ModuleManager maps an undefined key to the module id; the ingest side pins 0 -> undefined.
        const g = drainGroups([video('vp'), audio('out302')], av, keyed({ 'rist-in': TL_A }));
        expect(g.groups).toEqual([]);
        // Two members of the one 0-id ingest still group by its module id, as before Trust.
        const one = [e('srt-in', 'vp'), e('srt-in', 'dec')];
        expect(sorted(drainGroups([video('vp'), audio('dec')], one, keyed({})).groups)).toEqual([
            ['dec', 'vp'],
        ]);
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

    it('P is the max of the published targets, to every member each refresh; one alone is told so once', () => {
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
        expect(solo.applied).toEqual([[DRAIN_GROUP_ALONE_NS, {}]]);
    });

    it("early members (targets below 0, a network ingest's lead) are grouped at the max all the same (B-177)", () => {
        const vp = member('vp', true, -520);
        const dec = member('dec', false, -110);
        const loop = new DrainGroupLoop({
            members: () => [vp.m, dec.m],
            edges: () => edges,
            log: vi.fn(),
        });
        loop.tick();
        expect(vp.applied).toEqual([[-110e6, { with: ['DEC'] }]]);
        expect(dec.applied).toEqual([[-110e6, { with: ['VP'] }]]);
    });

    it("each member gets the others' render lateness in their order, null where unknown (B-241)", () => {
        const vp = member('vp', true, 180);
        const dec = member('dec', false, 120);
        const out = member('out', false);
        vp.m.renderMs = 4800;
        dec.m.renderMs = 300;
        new DrainGroupLoop({
            members: () => [vp.m, dec.m, out.m],
            edges: () => edges,
            log: vi.fn(),
        }).tick();
        expect(vp.applied[0][1]).toEqual({ with: ['DEC', 'OUT'], withRenderMs: [300, null] });
        expect(out.applied[0][1]).toEqual({ with: ['VP', 'DEC'], withRenderMs: [4800, 300] });
    });

    it('a group none of whose members publishes yet is sent alone, not a target of 0', () => {
        const vp = member('vp', true);
        const dec = member('dec', false);
        new DrainGroupLoop({
            members: () => [vp.m, dec.m],
            edges: () => edges,
            log: vi.fn(),
        }).tick();
        expect(vp.applied[0][0]).toBe(DRAIN_GROUP_ALONE_NS);
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
        expect(mix.applied).toEqual([[DRAIN_GROUP_ALONE_NS, { neither: ['V1', 'V2'] }]]);
    });
});

describe('DrainGroupLoop: Trust keys (p5-20)', () => {
    const av = [e('srt-in', 'vp'), e('rist-in', 'out302', A302)];

    it('(c) a key that moves (a fallback) regroups at the next refresh, logged; its return regroups again', () => {
        const vp = member('vp', true, 300);
        const out = member('out302', false, 120);
        const keys: Record<string, string> = { 'srt-in': TL_A, 'rist-in': TL_A };
        const log = vi.fn();
        const loop = new DrainGroupLoop({
            members: () => [vp.m, out.m],
            edges: () => av,
            keyOf: keyed(keys),
            log,
        });
        loop.tick();
        expect(sorted(loop.current().groups)).toEqual([['out302', 'vp']]);
        expect(out.applied.at(-1)).toEqual([300e6, { with: ['VP'] }]);
        expect(log).not.toHaveBeenCalled();
        delete keys['rist-in']; // its trust-fallback event: the ingest's key is undefined at once
        loop.tick();
        expect(loop.current().groups).toEqual([]);
        expect(out.applied.at(-1)).toEqual([DRAIN_GROUP_ALONE_NS, {}]);
        expect(vp.applied.at(-1)).toEqual([DRAIN_GROUP_ALONE_NS, {}]);
        expect(log.mock.calls.map((c) => c[0]).sort()).toEqual([
            "OUT302: drains alone: an input's sender timeline changed",
            "VP: drains alone: an input's sender timeline changed",
        ]);
        keys['rist-in'] = TL_A; // back through converging
        loop.tick();
        expect(sorted(loop.current().groups)).toEqual([['out302', 'vp']]);
        expect(out.applied.at(-1)).toEqual([300e6, { with: ['VP'] }]);
        expect(log).toHaveBeenCalledTimes(4);
        expect(log.mock.calls[2][1]).toMatchObject({ keys: { 'rist-in': `tl:${TL_A}` } });
        loop.tick();
        expect(log).toHaveBeenCalledTimes(4);
    });

    it('(h) published targets 1.4 s apart: each member is told the spread; within 1 s it is not', () => {
        const vp = member('vp', true, 1500);
        const out = member('out302', false, 100);
        const keys = keyed({ 'srt-in': TL_A, 'rist-in': TL_A });
        new DrainGroupLoop({
            members: () => [vp.m, out.m],
            edges: () => av,
            keyOf: keys,
            log: vi.fn(),
        }).tick();
        expect(vp.applied[0]).toEqual([1500e6, { with: ['OUT302'], spreadMs: 1400 }]);
        expect(out.applied[0]).toEqual([1500e6, { with: ['VP'], spreadMs: 1400 }]);
        const near = member('out302', false, 500);
        const vp2 = member('vp', true, 1500);
        new DrainGroupLoop({
            members: () => [vp2.m, near.m],
            edges: () => av,
            keyOf: keys,
            log: vi.fn(),
        }).tick();
        expect(near.applied[0]).toEqual([1500e6, { with: ['VP'] }]);
    });
});

describe('DrainGroupLoop: one sender over two links of different latency (fix B, DEV-104 blocker 2)', () => {
    // r104rx on .156: SRT (120 ms) and RIST (1 s) from one sender, both Trust, each to a Video Player
    // and an Audio Decoder; the members' own latencies as measured there (4/rx.jsonl, fb-diag1).
    const links = [
        e('srt-in', 'vp-srt'),
        e('srt-in', 'dec-srt'),
        e('rist-in', 'vp-rist'),
        e('rist-in', 'dec-rist'),
    ];
    const keys = keyed({ 'srt-in': TL_A, 'rist-in': TL_A });
    const OWN: Record<string, number> = {
        'vp-srt': 220,
        'dec-srt': 700,
        'vp-rist': 1150,
        'dec-rist': 1535,
    };

    /** Each member as its element plays it, every 2 s refresh: it publishes its own target and moves
     *  toward min(P, own + 1 s) at 0.5 % (10 ms a refresh); a player steps there at once the first
     *  time it is grouped (its start). `covered`: the ids whose display presents nothing until
     *  `shownAt` s: no target published, unpaced at its own latency, the group target not followed. */
    function play(seconds: number, covered: string[] = [], shownAt = Infinity) {
        const render: Record<string, number> = { ...OWN };
        const stepped = new Set<string>();
        const target: Record<string, number> = {};
        const at = (t: number, id: string) => !covered.includes(id) || t >= shownAt;
        let t = 0;
        const members = (): DrainMember[] =>
            Object.keys(OWN).map((id) => ({
                id,
                anchor: id.startsWith('vp'),
                name: id,
                ...(at(t, id) ? { publishedMs: OWN[id] } : {}),
                renderMs: render[id],
                apply: (ns: number) => {
                    target[id] = ns === DRAIN_GROUP_ALONE_NS ? OWN[id] : ns / 1e6;
                },
            }));
        const loop = new DrainGroupLoop({ members, edges: () => links, keyOf: keys, log: vi.fn() });
        const av: Array<{ t: number; srt: number; rist: number; dec: number }> = [];
        for (t = 2; t <= seconds; t += 2) {
            loop.tick();
            for (const id of Object.keys(OWN)) {
                if (!at(t, id)) {
                    render[id] = OWN[id];
                    continue;
                }
                const goal = Math.min(target[id] ?? OWN[id], OWN[id] + 1000);
                if (id.startsWith('vp') && !stepped.has(id) && target[id] !== undefined) {
                    stepped.add(id);
                    render[id] = goal;
                } else render[id] += Math.max(-10, Math.min(10, goal - render[id]));
            }
            av.push({
                t,
                srt: render['vp-srt'] - render['dec-srt'],
                rist: render['vp-rist'] - render['dec-rist'],
                dec: render['dec-srt'],
            });
        }
        return av;
    }

    it('every player visible: each link in lip sync from the first refresh (within 45 ms) for 10 min', () => {
        const av = play(600);
        const worst = (k: 'srt' | 'rist') => Math.max(...av.map((r) => Math.abs(r[k])));
        // One group of four would hold the SRT player at its own + 1 s (1220 ms) while its decoder rose to
        // the RIST link's 1535 ms: SRT A/V -315 ms and falling.
        expect(worst('srt')).toBeLessThanOrEqual(45);
        expect(worst('rist')).toBeLessThanOrEqual(45);
    });

    it("the device's shape: the SRT player covered (presents nothing), its decoder is not raised toward the RIST link; shown again, in sync at once", () => {
        const av = play(600, ['vp-srt'], 300);
        const covered = av.filter((r) => r.t < 300);
        // Before the fix the decoder rose 700 -> 1535 ms with the RIST link: A/V -480 -> -1315 ms, growing
        // (DEV-104: -411 at 8 s, -1223 at 600 s).
        expect(Math.max(...covered.map((r) => r.dec))).toBeLessThanOrEqual(OWN['dec-srt'] + 45);
        expect(Math.min(...covered.map((r) => r.srt))).toBeGreaterThanOrEqual(-480 - 45);
        const shown = av.filter((r) => r.t >= 302);
        expect(Math.max(...shown.map((r) => Math.abs(r.srt)))).toBeLessThanOrEqual(45);
        expect(Math.max(...av.map((r) => Math.abs(r.rist)))).toBeLessThanOrEqual(45);
    });

    it('split by link: each link a group of its own, the rows name it, logged once; joined again within 900 ms', () => {
        const mk = (id: string, ms: number) => member(id, id.startsWith('vp'), ms);
        const ms: Record<string, number> = {
            'vp-srt': 220,
            'dec-srt': 700,
            'vp-rist': 1150,
            'dec-rist': 1535,
        };
        const m = Object.fromEntries(Object.keys(ms).map((id) => [id, mk(id, ms[id])]));
        const log = vi.fn();
        const loop = new DrainGroupLoop({
            members: () => Object.keys(ms).map((id) => ({ ...m[id].m, publishedMs: ms[id] })),
            edges: () => links,
            keyOf: keys,
            log,
        });
        loop.tick();
        expect(m['vp-srt'].applied.at(-1)).toEqual([700e6, { with: ['DEC-SRT'], linksMs: 1315 }]);
        expect(m['dec-rist'].applied.at(-1)).toEqual([
            1535e6,
            { with: ['VP-RIST'], linksMs: 1315 },
        ]);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][0]).toContain('each link in sync on its own');
        ms['vp-srt'] = 580; // 955 ms apart: still split (within 1 s, not within 900 ms)
        loop.tick();
        expect(m['vp-srt'].applied.at(-1)?.[1]).toMatchObject({ linksMs: 955 });
        ms['vp-srt'] = 640; // 895 ms: one group of four again
        loop.tick();
        expect(m['vp-srt'].applied.at(-1)).toEqual([
            1535e6,
            { with: ['VP-RIST', 'DEC-SRT', 'DEC-RIST'] },
        ]);
        expect(log).toHaveBeenCalledTimes(2);
        expect(log.mock.calls[1][0]).toContain('in sync across the links again');
    });

    it("a staggered start (the RIST decoder has no reading yet): held by link, no player told the other link's target (review B1)", () => {
        // .156's start order: the RIST player publishes one refresh before the RIST decoder has a row.
        const ticks: Array<Record<string, { pub?: number; render?: number }>> = [
            {
                'vp-srt': { pub: 280, render: 280 },
                'dec-srt': { pub: 757, render: 757 },
                'vp-rist': { pub: 1184, render: 1184 },
                'dec-rist': {},
            },
            {
                'vp-srt': { pub: 280, render: 757 },
                'dec-srt': { pub: 757, render: 757 },
                'vp-rist': { pub: 1184, render: 1184 },
                'dec-rist': { pub: 1558, render: 1558 },
            },
        ];
        let cur = ticks[0];
        const got: Record<string, Array<[number, unknown]>> = {};
        const log = vi.fn();
        const loop = new DrainGroupLoop({
            members: () =>
                Object.keys(cur).map((id) => ({
                    id,
                    anchor: id.startsWith('vp'),
                    name: id.toUpperCase(),
                    ...(cur[id].pub !== undefined ? { publishedMs: cur[id].pub } : {}),
                    ...(cur[id].render !== undefined ? { renderMs: cur[id].render } : {}),
                    apply: (ns: number, view: unknown) => (got[id] ??= []).push([ns, view]),
                })),
            edges: () => links,
            keyOf: keys,
            log,
        });
        loop.tick();
        expect(got['vp-srt'][0]).toEqual([757e6, { with: ['DEC-SRT'], withRenderMs: [757] }]);
        expect(got['vp-rist'][0]).toEqual([1184e6, { with: ['DEC-RIST'] }]);
        expect(log).not.toHaveBeenCalled();
        cur = ticks[1];
        loop.tick();
        expect(got['vp-srt'][1]).toEqual([
            757e6,
            { with: ['DEC-SRT'], withRenderMs: [757], linksMs: 1278 },
        ]);
        expect(Math.max(...got['vp-srt'].map(([ns]) => ns))).toBe(757e6);
        expect(log).toHaveBeenCalledTimes(1);
    });

    it('one Trust link whose members are more than 1 s apart is not reported as split: one capped group (review F2)', () => {
        const vp = member('vp', true, 200);
        const dec = member('dec', false, 1300);
        const log = vi.fn();
        new DrainGroupLoop({
            members: () => [vp.m, dec.m],
            edges: () => [e('srt-in', 'vp'), e('srt-in', 'dec')],
            keyOf: keys,
            log,
        }).tick();
        expect(vp.applied[0]).toEqual([1300e6, { with: ['DEC'], spreadMs: 1100 }]);
        expect(log).not.toHaveBeenCalled();
    });

    it('a link with no programme of its own (video over SRT, audio over RIST) stays one capped group (p5-20 E5)', () => {
        const vp = member('vp', true, 1500);
        const out = member('out302', false, 100);
        new DrainGroupLoop({
            members: () => [vp.m, out.m],
            edges: () => [e('srt-in', 'vp'), e('rist-in', 'out302', A302)],
            keyOf: keys,
            log: vi.fn(),
        }).tick();
        expect(out.applied[0]).toEqual([1500e6, { with: ['VP'], spreadMs: 1400 }]);
    });

    it('a member a split leaves alone is told so: the RIST decoder with no RIST player', () => {
        const ms: Record<string, number> = { 'vp-srt': 220, 'dec-srt': 700, 'dec-rist': 1535 };
        const m = Object.fromEntries(
            Object.keys(ms).map((id) => [id, member(id, id.startsWith('vp'), ms[id])]),
        );
        const loop = new DrainGroupLoop({
            members: () => Object.values(m).map((x) => x.m),
            edges: () => links.filter((x) => x.sinkModuleId !== 'vp-rist'),
            keyOf: keys,
            log: vi.fn(),
        });
        loop.tick();
        loop.tick();
        expect(m['vp-srt'].applied.at(-1)).toEqual([700e6, { with: ['DEC-SRT'], linksMs: 1315 }]);
        expect(m['dec-rist'].applied).toEqual([[DRAIN_GROUP_ALONE_NS, { linksMs: 1315 }]]);
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
        await mod.applyLatencyGroupTarget(-520_000_000, { with: ['Video Player'] });
        expect(setProperty).toHaveBeenLastCalledWith('outasrc', 'group-target-ns', -520_000_000);
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
