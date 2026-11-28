import * as shared from '@media-router/shared-types';
import type { EditorLayout, RefKind } from '@media-router/shared-types';
import type { ConnectionState, ModuleState, PortInfo } from '@/stores/engines';
import {
    STUB_EDGE_PREFIX,
    type DerivedRefs,
    type RefLink,
    type RefNode,
    type StubEdge,
} from './crossRefTypes';
import { edgeColor, IDLE_EDGE_COLOR } from './edgeStyle';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { DEFAULT_PAGE_NAME, refKey } = shared;

// Pages and cross-reference tags of the routing editor (ADR-0030). Tags are
// derived here from the connections; `editor.refs` only adds number, name and
// dragged position. Ports on other pages to link to: crossRefCandidates.ts;
// module moves: crossRefMoves.ts; the op lists: pageOps.ts.

/**
 * Id of the one implicit "Page 1" of a layout with no pages. Materialising
 * writes the page under this id (pageOps.ts), so a viewer's `?page=` survives.
 */
export const IMPLICIT_PAGE_ID = 'pg-1';
export const PCM = 'audio/pcm';

export interface PageEntry {
    id: string;
    name: string;
    order: number;
}

/** Pages in tab order (order, then name, then id); the implicit "Page 1" when there are none. */
export function sortedPages(editor: EditorLayout | undefined): PageEntry[] {
    const pages = Object.entries(editor?.pages ?? {}).map(([id, p]) => ({ id, ...p }));
    if (pages.length === 0) return [{ id: IMPLICIT_PAGE_ID, name: DEFAULT_PAGE_NAME, order: 0 }];
    return pages.sort(
        (a, b) => a.order - b.order || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1),
    );
}

/** pageId → name, the implicit page included. */
export function pageNamesOf(editor: EditorLayout | undefined): Record<string, string> {
    return Object.fromEntries(sortedPages(editor).map((p) => [p.id, p.name]));
}

/** `pageOf` for many modules: the lowest-order page is found once. */
export function pageResolver(editor: EditorLayout | undefined): (moduleId: string) => string {
    const pages = editor?.pages ?? {};
    const lowest = sortedPages(editor)[0].id;
    return (moduleId) => {
        const stored = editor?.modulePages[moduleId];
        return typeof stored === 'string' && Object.hasOwn(pages, stored) ? stored : lowest;
    };
}

/** A module's page: its stored page if that page exists, else the lowest-order page. */
export function pageOf(editor: EditorLayout | undefined, moduleId: string): string {
    return pageResolver(editor)(moduleId);
}

/** A numbered tag's face: its name, else `#n`, else '…' while the manager numbers it. */
export function refLabel(name: string | undefined, n: number | undefined): string {
    return name || (n !== undefined ? `#${n}` : '…');
}

function portOf(mod: ModuleState, portId: string): PortInfo | undefined {
    return mod.ports?.find((p) => p.id === portId);
}

/** A tag being built: its links first, the rest once every connection is seen. */
interface Draft {
    kind: RefKind;
    moduleId: string;
    portId: string;
    page: string;
    port?: PortInfo;
    links: RefLink[];
}

/**
 * Classify every connection whose two modules exist (dangling ones are
 * skipped, as the canvas always has): a direct wire when both ends share a
 * page and it is not tagged, else a tag link. Tag links are grouped per port
 * key, so a port has at most one output (or input) tag however many links run
 * through it. `tagged` is ignored for PipeWire and unknown port types; such a
 * link across pages is read-only (grey, no number).
 */
export function deriveRefs(
    modules: Record<string, ModuleState>,
    connections: readonly ConnectionState[],
    editor: EditorLayout | undefined,
    pageNames: Record<string, string>,
): DerivedRefs {
    const pageFor = pageResolver(editor);
    const derived: DerivedRefs = { directConnectionIds: [], links: [], refs: {} };
    const drafts = new Map<string, Draft>();
    const draft = (key: string, d: Omit<Draft, 'links'>, link: RefLink) => {
        const entry = drafts.get(key) ?? { ...d, links: [] };
        entry.links.push(link);
        drafts.set(key, entry);
    };

    for (const c of connections) {
        const src = modules[c.sourceModuleId];
        const sink = modules[c.sinkModuleId];
        if (!src || !sink) continue;
        const srcPort = portOf(src, c.sourcePortId);
        const sinkPort = portOf(sink, c.sinkPortId);
        const sourcePage = pageFor(c.sourceModuleId);
        const sinkPage = pageFor(c.sinkModuleId);
        const plain = [srcPort, sinkPort].every((p) => !!p?.streamType && p.streamType !== PCM);
        const cross = sourcePage !== sinkPage;
        const tagged = plain && editor?.tagged[c.id] === true;
        if (!cross && !tagged) {
            derived.directConnectionIds.push(c.id);
            continue;
        }
        const link: RefLink = {
            connectionId: c.id,
            outKey: refKey('out', c.sourceModuleId, c.sourcePortId),
            inKey: refKey('in', c.sinkModuleId, c.sinkPortId),
            sourceModuleId: c.sourceModuleId,
            sourcePortId: c.sourcePortId,
            sinkModuleId: c.sinkModuleId,
            sinkPortId: c.sinkPortId,
            sourcePage,
            sinkPage,
            tagged: tagged && !cross,
            readOnly: !plain,
        };
        derived.links.push(link);
        const out = { moduleId: c.sourceModuleId, portId: c.sourcePortId, page: sourcePage };
        draft(link.outKey, { kind: 'out', ...out, port: srcPort }, link);
        const inEnd = { moduleId: c.sinkModuleId, portId: c.sinkPortId, page: sinkPage };
        draft(link.inKey, { kind: 'in', ...inEnd, port: sinkPort }, link);
    }

    for (const [key, d] of drafts) derived.refs[key] = finish(key, d, modules, editor, pageNames);
    return derived;
}

function finish(
    key: string,
    d: Draft,
    modules: Record<string, ModuleState>,
    editor: EditorLayout | undefined,
    pageNames: Record<string, string>,
): RefNode {
    const out = d.kind === 'out';
    // Colour follows the feed: an output's own type, an input's first known source type.
    const feed = out
        ? d.port?.streamType
        : d.links
              .map((l) => portOf(modules[l.sourceModuleId], l.sourcePortId)?.streamType)
              .find((t) => !!t);
    const streamType = feed || null;
    const readOnly = d.links.every((l) => l.readOnly);
    const stored =
        !readOnly && editor && Object.hasOwn(editor.refs, key) ? editor.refs[key] : undefined;
    const pcm = streamType === PCM || d.port?.streamType === PCM;
    // The tags at the other end, by key, with their pages.
    const far = new Map(
        d.links.map((l): [string, string] =>
            out ? [l.inKey, l.sinkPage] : [l.outKey, l.sourcePage],
        ),
    );
    const arrow = out ? '→' : '←';
    const hint =
        far.size === 1
            ? `${arrow} ${pageNames[[...far.values()][0]] ?? DEFAULT_PAGE_NAME}`
            : `${arrow} ${far.size} refs`;
    return {
        key,
        kind: d.kind,
        moduleId: d.moduleId,
        portId: d.portId,
        page: d.page,
        streamType,
        color: readOnly ? IDLE_EDGE_COLOR : edgeColor(streamType),
        readOnly,
        n: stored?.n,
        name: stored?.name || undefined,
        label: readOnly ? (pcm ? 'PCM' : '?') : refLabel(stored?.name, stored?.n),
        hint,
        pos: stored?.pos,
        capacity: d.port?.maxConnections ?? -1,
        links: d.links,
    };
}

/** The tags drawn on one page. */
export function refsOnPage(derived: DerivedRefs, page: string): RefNode[] {
    return Object.values(derived.refs).filter((r) => r.page === page);
}

/** One stub edge per tag on the page, between the module port and its tag. */
export function stubsOnPage(derived: DerivedRefs, page: string): StubEdge[] {
    return refsOnPage(derived, page).map((r) => ({
        id: STUB_EDGE_PREFIX + r.key,
        refKey: r.key,
        kind: r.kind,
        moduleId: r.moduleId,
        portId: r.portId,
        connectionIds: r.links.map((l) => l.connectionId),
    }));
}

/** The connections drawn as ordinary wires on one page. */
export function directOnPage(
    derived: DerivedRefs,
    connections: readonly ConnectionState[],
    editor: EditorLayout | undefined,
    page: string,
): ConnectionState[] {
    const direct = new Set(derived.directConnectionIds);
    const pageFor = pageResolver(editor);
    return connections.filter((c) => direct.has(c.id) && pageFor(c.sourceModuleId) === page);
}

/** Tags, engine-wide, still waiting for their number (no stored record; read-only ones never get one). */
export function missingRefKeys(derived: DerivedRefs): string[] {
    return Object.values(derived.refs)
        .filter((r) => !r.readOnly && r.n === undefined)
        .map((r) => r.key);
}

/**
 * Stored records, engine-wide, with a dragged place but no tag drawn any more
 * (its far end moved back, its last link removed): the place is forgotten, so
 * a tag that comes back sits beside its port. Read-only tags keep theirs.
 */
export function stalePositionKeys(
    editor: EditorLayout | undefined,
    derived: DerivedRefs,
): string[] {
    return Object.entries(editor?.refs ?? {})
        .filter(([key, ref]) => ref.pos !== undefined && !derived.refs[key])
        .map(([key]) => key);
}
