/**
 * Shared shapes of the routing editor's pages and cross-reference tags
 * (ADR-0030). `deriveRefs` (utils/crossRefs.ts) produces them; the canvas,
 * XrefNode, XrefLinkPicker, XrefSettingsPanel and PageTabs consume them.
 */
import type { RefKind } from '@media-router/shared-types';

/** One connection drawn through tags: an output tag at its source port, an input tag at its sink port. */
export interface RefLink {
    connectionId: string;
    /** refKey('out', sourceModuleId, sourcePortId) */
    outKey: string;
    /** refKey('in', sinkModuleId, sinkPortId) */
    inKey: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkModuleId: string;
    sinkPortId: string;
    sourcePage: string;
    sinkPage: string;
    /** In `editor.tagged` and both ends on one page ("Show as cross-reference"). */
    tagged: boolean;
    /** A PipeWire (audio/pcm) wire across pages, or one with an unknown port type: grey, read-only. */
    readOnly: boolean;
}

/** A tag on a page. One per (kind, module, port) that has at least one tag link. */
export interface RefNode {
    key: string;
    kind: RefKind;
    moduleId: string;
    portId: string;
    /** The module's page. */
    page: string;
    /** The feed's stream type: an output tag's own port type, an input tag's feed type. Null = unknown. */
    streamType: string | null;
    /** Resolved fill colour (STREAM_TYPE_COLORS; grey when read-only). */
    color: string;
    readOnly: boolean;
    /** Stored number; absent until the manager has assigned it (and always absent for read-only tags). */
    n?: number;
    name?: string;
    /** name || `#n` || '…' while the number is pending || 'PCM' for a read-only PipeWire tag. */
    label: string;
    /** '→ <page name>' / '→ 3 refs' (output), '← <page name>' / '← 3 refs' (input). */
    hint: string;
    /** Stored dragged position; absent = placed beside its port. */
    pos?: { x: number; y: number };
    /** The port's maxConnections (-1 unlimited, N limit). */
    capacity: number;
    /** Every tag link through this tag. */
    links: RefLink[];
}

/** Everything drawn for one engine, all pages. Filter per page with the helpers in crossRefs.ts. */
export interface DerivedRefs {
    /** Connections drawn as ordinary wires (both ends on one page, not tagged). */
    directConnectionIds: string[];
    /** Connections drawn through tags. */
    links: RefLink[];
    /** Every tag, keyed by ref key. */
    refs: Record<string, RefNode>;
}

/** The short edge between a module port and its tag (one per tag), id `ref:<key>`. */
export interface StubEdge {
    id: string;
    refKey: string;
    kind: RefKind;
    moduleId: string;
    portId: string;
    /** The connections behind the tag; the stub flows when any of them flows. */
    connectionIds: string[];
}

export const STUB_EDGE_PREFIX = 'ref:';
export const XREF_NODE_TYPE = 'xref';
/**
 * Id of a tag's only handle (XrefNode). Stub edges name it: `targetHandle` on
 * an output tag's stub (module output → tag), `sourceHandle` on an input tag's
 * stub (tag → module input). Fixed rather than the port id, which may hold ':'.
 */
export const XREF_HANDLE_ID = 'tag';

/** Vue Flow `data` of an xref node. */
export interface XrefNodeData {
    ref: RefNode;
    dimmed?: boolean;
    highlighted?: boolean;
}

/** XrefNode emits: `open` (tap/click → dropdown at the pointer), `settings` (double-click → side panel). */
export interface XrefNodeEmits {
    open: [key: string, clientX: number, clientY: number];
    settings: [key: string];
}

/**
 * Tag dropdown actions (utils/xrefMenuItems.ts builds the MrContextMenu items):
 * `goto:<refKey>`, `chmap:<connectionId>`, `label:<connectionId>`, `wire:<connectionId>`,
 * `unlink:<connectionId>`, `link`, `settings`.
 */
export type XrefMenuAction = string;

/** A port on another page that a dropped wire can be linked to. */
export interface LinkCandidate {
    pageId: string;
    pageName: string;
    moduleId: string;
    moduleName: string;
    portId: string;
    portLabel: string;
    streamType: string;
    /** Label of the tag this port already has, if any. */
    existingRefLabel?: string;
}

export interface XrefLinkPickerProps {
    /** Screen position of the drop. */
    x: number;
    y: number;
    candidates: LinkCandidate[];
}
export interface XrefLinkPickerEmits {
    pick: [candidate: LinkCandidate];
    close: [];
}

export interface PageTab {
    id: string;
    name: string;
    moduleCount: number;
}
export interface PageTabsProps {
    /** Sorted by order. */
    pages: PageTab[];
    currentId: string;
}
export interface PageTabsEmits {
    select: [id: string];
    add: [];
    rename: [id: string, name: string];
    move: [id: string, delta: -1 | 1];
    /** Delete `id`, moving its modules to `targetId`. */
    delete: [id: string, targetId: string];
}

export interface XrefSettingsPanelProps {
    /** Not `ref`: that name is reserved in Vue templates. */
    refNode: RefNode;
    pageNames: Record<string, string>;
    moduleNames: Record<string, string>;
}
export interface XrefSettingsPanelEmits {
    close: [];
    /** null = clear the name (the number shows again). */
    rename: [key: string, name: string | null];
    goto: [key: string];
    unlink: [connectionId: string];
    selectModule: [moduleId: string];
}
