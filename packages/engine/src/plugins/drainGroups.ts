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
    /** Their render lateness (ms) in `with`'s order, null where unknown; absent: none known (B-241). */
    withRenderMs?: Array<number | null>;
    /** Its origins touch two groups: it drains alone (two programmes). */
    neither?: string[];
    /** How far its group's published targets spread (ms), when past the 1 s rise cap (p5-20). */
    spreadMs?: number;
    /** Its sender timeline's links spread this far (ms), past the rise cap: each link is a group of its
     *  own (fix B). */
    linksMs?: number;
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

/** An origin module's key (p5-20): `tl:` + the sender's timeline id for an ingest on the Trust
 *  timeline, so two ingests of one sender programme are one origin; else the module id. */
export type DrainOriginKeyOf = (moduleId: string) => string;

/** The groups: Video Players sharing an origin form one (a player whose origins touch two such
 *  groups stays apart, never chaining them); each audio output joins the one group its origins
 *  touch, origins touching none ignored; one touching two joins neither. Origins compare by
 *  `keyOf` (default: the module id). */
export function drainGroups(
    members: readonly DrainMemberRef[],
    edges: readonly DrainEdge[],
    keyOf: DrainOriginKeyOf = (id) => id,
): DrainGrouping {
    const origins = new Map(
        members.map((m) => [m.id, new Set([...busOrigins(m.id, edges)].map(keyOf))]),
    );
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
    /** Its render lateness as its drain last read it (ms). */
    renderMs?: number;
    apply(targetNs: number, view: DrainGroupView): void;
}

export interface DrainHost {
    members(): DrainMember[];
    edges(): DrainEdge[];
    /** The origins' keys (p5-20); absent: every module its own id. */
    keyOf?: DrainOriginKeyOf;
    log(msg: string, obj: Record<string, unknown>): void;
}

/** p4-18 E21: a member rises at most 1 s to its group; past it the spread is named (p5-20). */
export const DRAIN_RISE_CAP_MS = 1000;
/** A timeline group split by its links (fix B) joins again only within the cap less this. */
export const DRAIN_LINKS_REJOIN_MS = 100;

/** The engine's half: at each refresh (2 s) P = the max of each group's published targets, to
 *  every member, below 0 too (early outputs); the groups again only when the members, the routing
 *  or an origin's key change. A member alone, or a group none of whose members publishes, gets
 *  DRAIN_GROUP_ALONE_NS. */
export class DrainGroupLoop {
    private key = '';
    private keys = '';
    private grouping: DrainGrouping = { groups: [], neither: new Map() };
    private readonly alone = new Map<string, string>();
    private readonly logged = new Set<string>();
    /** The timeline groups split by their links now (fix B), by their sorted member ids. */
    private split = new Set<string>();

    constructor(private readonly host: DrainHost) {}

    /** The groups last computed (tests, the log). */
    current(): DrainGrouping {
        return this.grouping;
    }

    tick(): void {
        const members = this.host.members();
        const edges = this.host.edges();
        const keyOf = this.host.keyOf ?? ((id: string) => id);
        const key = JSON.stringify([
            members.map((m) => [m.id, m.anchor]).sort(),
            edges.map((e) => [e.sourceModuleId, e.sinkModuleId, e.streamType]).sort(),
        ]);
        // Only the keys that differ from their module id: a Trust ingest on a sender timeline.
        const keyed = [...new Set(edges.map((e) => e.sourceModuleId))]
            .sort()
            .flatMap((id) => (keyOf(id) === id ? [] : [[id, keyOf(id)]]));
        const keys = JSON.stringify(keyed);
        if (key !== this.key || keys !== this.keys) {
            const before = this.grouping;
            const regroup = key === this.key;
            this.key = key;
            this.keys = keys;
            this.grouping = drainGroups(members, edges, keyOf);
            if (regroup) this.logRegroup(before, members, keyed);
        }
        const byId = new Map(members.map((m) => [m.id, m]));
        const grouped = new Set<string>();
        const { groups, linksAlone } = this.byLinks(byId, edges, keyOf);
        for (const { ids, linksMs } of groups) {
            const live = ids.map((id) => byId.get(id)).filter((m): m is DrainMember => !!m);
            const published = live.flatMap((m) =>
                m.publishedMs === undefined ? [] : [m.publishedMs],
            );
            const spread = published.length ? Math.max(...published) - Math.min(...published) : 0;
            for (const m of live) {
                grouped.add(m.id);
                this.alone.delete(m.id);
                const others = live.filter((o) => o !== m);
                const p = published.length
                    ? Math.max(DRAIN_GROUP_ALONE_NS + 1, Math.round(Math.max(...published) * 1e6))
                    : DRAIN_GROUP_ALONE_NS;
                const view: DrainGroupView = { with: others.map((o) => o.name) };
                if (others.some((o) => o.renderMs !== undefined))
                    view.withRenderMs = others.map((o) => o.renderMs ?? null);
                if (spread > DRAIN_RISE_CAP_MS) view.spreadMs = spread;
                if (linksMs !== undefined) view.linksMs = linksMs;
                m.apply(p, view);
            }
        }
        for (const m of members) {
            if (grouped.has(m.id)) continue;
            const linksMs = linksAlone.get(m.id);
            const told = `${linksMs ?? ''}`;
            if (this.alone.get(m.id) === told) continue;
            this.alone.set(m.id, told);
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
            const view: DrainGroupView = names ? { neither: names } : {};
            if (linksMs !== undefined) view.linksMs = linksMs;
            m.apply(DRAIN_GROUP_ALONE_NS, view);
        }
        for (const id of [...this.alone.keys()]) if (!byId.has(id)) this.alone.delete(id);
    }

    /** Fix B (owner's veto): the links of one sender share a group while every member can reach it
     *  within the 1 s rise cap. Past it, a link that carries a programme of its own (a player and
     *  what plays with it) keeps its own lip sync first: the group splits by link, its members
     *  grouped by their ingest modules as p4-18 groups them, and what no link groups drains alone.
     *  Until every member has a reading, a group of several links is held by link (B1).
     *  The spread reads each member's published target, else its render lateness (a player whose
     *  display presents nothing publishes none). Joined again within the cap less 100 ms. */
    private byLinks(
        byId: Map<string, DrainMember>,
        edges: DrainEdge[],
        keyOf: DrainOriginKeyOf,
    ): { groups: Array<{ ids: string[]; linksMs?: number }>; linksAlone: Map<string, number> } {
        const groups: Array<{ ids: string[]; linksMs?: number }> = [];
        const linksAlone = new Map<string, number>();
        const split = new Set<string>();
        for (const ids of this.grouping.groups) {
            const live = ids.map((id) => byId.get(id)).filter((m): m is DrainMember => !!m);
            const own = live.flatMap((m) => {
                const v = m.publishedMs ?? m.renderMs;
                return v === undefined ? [] : [v];
            });
            const spread = own.length ? Math.max(...own) - Math.min(...own) : 0;
            const sig = [...ids].sort().join(' ');
            const keyed = live.some((m) =>
                [...busOrigins(m.id, edges)].some((o) => keyOf(o) !== o),
            );
            // By link: each ingest's own groups (p4-18's rule); a split needs two of them, or one and a
            // member it leaves alone (one Trust link spread past the cap stays one capped group).
            const links = keyed ? drainGroups(live, edges).groups : [];
            const lone = live.filter((m) => !links.some((g) => g.includes(m.id)));
            if (!(links.length >= 2 || (links.length === 1 && lone.length > 0))) {
                groups.push({ ids });
                continue;
            }
            // Until every member has a reading the spread is not known: held by link, no joint
            // target (a player would step to another link's latency and never come back, B1).
            if (own.length < live.length) {
                for (const sub of links) groups.push({ ids: sub });
                if (this.split.has(sig)) split.add(sig);
                continue;
            }
            const past = this.split.has(sig)
                ? spread > DRAIN_RISE_CAP_MS - DRAIN_LINKS_REJOIN_MS
                : spread > DRAIN_RISE_CAP_MS;
            if (!past) {
                groups.push({ ids });
                continue;
            }
            split.add(sig);
            const linksMs = Math.round(spread);
            for (const sub of links) groups.push({ ids: sub, linksMs });
            for (const m of lone) linksAlone.set(m.id, linksMs);
        }
        for (const sig of split) if (!this.split.has(sig)) this.logLinks(sig, byId, true);
        for (const sig of this.split) if (!split.has(sig)) this.logLinks(sig, byId, false);
        this.split = split;
        return { groups, linksAlone };
    }

    private logLinks(sig: string, byId: Map<string, DrainMember>, apart: boolean): void {
        const names = sig.split(' ').map((id) => byId.get(id)?.name ?? id);
        this.host.log(
            apart
                ? `${names.join(', ')}: each link in sync on its own: one sender's links differ by more than 1 s`
                : `${names.join(', ')}: in sync across the links again: within 1 s of each other`,
            { members: sig.split(' ') },
        );
    }

    /** A regroup an origin's key made (a Trust ingest reaching or leaving its sender's timeline):
     *  each member whose group changed, once. */
    private logRegroup(before: DrainGrouping, members: DrainMember[], keyed: string[][]): void {
        const names = new Map(members.map((m) => [m.id, m.name]));
        const partners = (g: DrainGrouping, id: string): string[] =>
            (g.groups.find((ids) => ids.includes(id)) ?? []).filter((x) => x !== id).sort();
        for (const m of members) {
            const was = partners(before, m.id);
            const now = partners(this.grouping, m.id);
            if (JSON.stringify(was) === JSON.stringify(now)) continue;
            const text = now.length
                ? `in sync with ${now.map((id) => names.get(id) ?? id).join(', ')}`
                : 'drains alone';
            this.host.log(`${m.name}: ${text}: an input's sender timeline changed`, {
                member: m.id,
                with: now,
                keys: Object.fromEntries(keyed),
            });
        }
    }
}
