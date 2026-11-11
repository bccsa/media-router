// A/V groups by common origin (house-clock WI-P4-18, B-179, design 7.1): the device outputs on this
// box whose bus paths trace back to the same input drain to one shared target, the largest of the
// members' own, so the same content plays at the same moment on each.
import { BUS_STREAM_TYPES } from '../routing/MediaRouter.js';
import { DRAIN_GROUP_ALONE_NS } from './drainSummary.js';

/** One routing edge, as `MediaRouter.getConnections()` gives it. */
export interface DrainEdge {
    sourceModuleId: string;
    sinkModuleId: string;
    streamType: string;
}

/** A running device output: a Video Player anchors a group, an audio output joins one. */
export interface DrainMemberRef {
    id: string;
    anchor: boolean;
}

/** What a member's timing section says of its group. */
export interface DrainGroupView {
    /** The other members' names. */
    with?: string[];
    /** Its origins touch two groups: it drains alone (two programmes). */
    neither?: string[];
}

export interface DrainGrouping {
    /** Each group's member ids, anchors first; groups of two or more only. */
    groups: string[][];
    /** Members whose origins touch two groups: the groups' first members (for the log). */
    neither: Map<string, string[]>;
}

/** The modules a module's bus path starts from: walked upstream over bus edges only (a PipeWire
 *  re-capture starts an origin of its own), with a visited set so a cycle ends the walk. An empty
 *  set: no origin (the walk found only a cycle). */
export function busOrigins(id: string, edges: readonly DrainEdge[]): Set<string> {
    const into = new Map<string, string[]>();
    for (const e of edges) {
        if (!BUS_STREAM_TYPES.has(e.streamType)) continue;
        into.set(e.sinkModuleId, [...(into.get(e.sinkModuleId) ?? []), e.sourceModuleId]);
    }
    const origins = new Set<string>();
    const seen = new Set<string>([id]);
    const todo = [...(into.get(id) ?? [])];
    while (todo.length) {
        const m = todo.pop()!;
        if (seen.has(m)) continue;
        seen.add(m);
        const up = into.get(m);
        if (!up?.length) origins.add(m);
        else todo.push(...up);
    }
    return origins;
}

const touches = (a: Set<string>, b: Set<string>): boolean => [...a].some((x) => b.has(x));

/** The groups: Video Players sharing an origin form one (a player whose origins touch two such
 *  groups stays apart, never chaining them); each audio output joins the one group its origins
 *  touch, origins touching none ignored; one touching two joins neither. */
export function drainGroups(
    members: readonly DrainMemberRef[],
    edges: readonly DrainEdge[],
): DrainGrouping {
    const origins = new Map(members.map((m) => [m.id, busOrigins(m.id, edges)]));
    const built: Array<{ ids: string[]; origins: Set<string> }> = [];
    const anchors = members.filter((m) => m.anchor && origins.get(m.id)!.size > 0);
    // Fewest origins first: the programmes; a player of several joins the one group it touches,
    // its other origins left out (no chaining); one touching two stays apart, joined by nothing.
    for (const a of [...anchors].sort(
        (x, y) => origins.get(x.id)!.size - origins.get(y.id)!.size,
    )) {
        const own = origins.get(a.id)!;
        const hit = built.filter((g) => touches(g.origins, own));
        if (hit.length === 1) hit[0].ids.push(a.id);
        else built.push({ ids: [a.id], origins: hit.length ? new Set() : new Set(own) });
    }
    const neither = new Map<string, string[]>();
    for (const m of members) {
        if (m.anchor) continue;
        const own = origins.get(m.id)!;
        if (!own.size) continue;
        const hit = built.filter((g) => touches(g.origins, own));
        if (hit.length === 1) hit[0].ids.push(m.id);
        else if (hit.length > 1)
            neither.set(
                m.id,
                hit.map((g) => g.ids[0]),
            );
    }
    return { groups: built.filter((g) => g.ids.length >= 2).map((g) => g.ids), neither };
}

/** A running device output as the loop sees it. */
export interface DrainMember extends DrainMemberRef {
    name: string;
    /** Its published target (`drain-target-lateness-ns`, ms); absent: it publishes none. */
    publishedMs?: number;
    apply(targetNs: number, view: DrainGroupView): void;
}

export interface DrainHost {
    members(): DrainMember[];
    edges(): DrainEdge[];
    log(msg: string, obj: Record<string, unknown>): void;
}

/** The engine's half: at each refresh (2 s) P = the max of each group's published targets, to
 *  every member, below 0 too (early outputs); the groups again only when the members or the routing
 *  change. A member alone, or a group none of whose members publishes, gets DRAIN_GROUP_ALONE_NS. */
export class DrainGroupLoop {
    private key = '';
    private grouping: DrainGrouping = { groups: [], neither: new Map() };
    private readonly alone = new Set<string>();
    private readonly logged = new Set<string>();

    constructor(private readonly host: DrainHost) {}

    /** The groups last computed (tests, the log). */
    current(): DrainGrouping {
        return this.grouping;
    }

    tick(): void {
        const members = this.host.members();
        const edges = this.host.edges();
        const key = JSON.stringify([
            members.map((m) => [m.id, m.anchor]).sort(),
            edges.map((e) => [e.sourceModuleId, e.sinkModuleId, e.streamType]).sort(),
        ]);
        if (key !== this.key) {
            this.key = key;
            this.grouping = drainGroups(members, edges);
        }
        const byId = new Map(members.map((m) => [m.id, m]));
        const grouped = new Set<string>();
        for (const ids of this.grouping.groups) {
            const live = ids.map((id) => byId.get(id)).filter((m): m is DrainMember => !!m);
            const published = live.flatMap((m) =>
                m.publishedMs === undefined ? [] : [m.publishedMs],
            );
            for (const m of live) {
                grouped.add(m.id);
                this.alone.delete(m.id);
                const others = live.filter((o) => o !== m).map((o) => o.name);
                const p = published.length
                    ? Math.max(DRAIN_GROUP_ALONE_NS + 1, Math.round(Math.max(...published) * 1e6))
                    : DRAIN_GROUP_ALONE_NS;
                m.apply(p, { with: others });
            }
        }
        for (const m of members) {
            if (grouped.has(m.id) || this.alone.has(m.id)) continue;
            this.alone.add(m.id);
            const two = this.grouping.neither.get(m.id);
            const names = two?.map((id) => byId.get(id)?.name ?? id);
            if (names && !this.logged.has(m.id)) {
                this.logged.add(m.id);
                this.host.log(
                    `${m.name}: in sync with neither ${names.join(' nor ')}: two programmes`,
                    {
                        member: m.id,
                        groups: two,
                    },
                );
            }
            m.apply(DRAIN_GROUP_ALONE_NS, names ? { neither: names } : {});
        }
        for (const id of [...this.alone]) if (!byId.has(id)) this.alone.delete(id);
    }
}
