import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import type { RefLink, RefNode } from '@/utils/crossRefTypes';
import { menuIcons } from '@/utils/moduleMenuItems';

export interface XrefMenuContext {
    /** Every tag of the engine, keyed by ref key (DerivedRefs.refs). */
    refs: Record<string, RefNode>;
    /** pageId → page name. */
    pageNames: Record<string, string>;
    /** moduleId → display name. */
    moduleNames: Record<string, string>;
    /** `portLabelKey(moduleId, portId)` → the port's label; the port id when missing. */
    portLabels?: Record<string, string>;
    /** A port on another page can take a link from this tag (linkCandidates, port capacity included). */
    hasCapacity: boolean;
}

/** Key of `XrefMenuContext.portLabels`; module ids hold no ':' so it is unambiguous. */
export const portLabelKey = (moduleId: string, portId: string): string => `${moduleId}:${portId}`;

/** The far end of `link` seen from `ref`: the input tag of an output tag's link, and back. */
export function counterpartOf(
    ref: Pick<RefNode, 'kind'>,
    link: RefLink,
): { key: string; moduleId: string; portId: string; page: string } {
    return ref.kind === 'out'
        ? {
              key: link.inKey,
              moduleId: link.sinkModuleId,
              portId: link.sinkPortId,
              page: link.sinkPage,
          }
        : {
              key: link.outKey,
              moduleId: link.sourceModuleId,
              portId: link.sourcePortId,
              page: link.sourcePage,
          };
}

type Names = Pick<XrefMenuContext, 'pageNames' | 'moduleNames' | 'portLabels'> & {
    refs?: Record<string, RefNode>;
};

/** '<tag label> · <page name> · <module>/<port>' for the far end of `link`; unknown parts are left out. */
export function counterpartLabel(ref: Pick<RefNode, 'kind'>, link: RefLink, names: Names): string {
    const far = counterpartOf(ref, link);
    const tag = names.refs?.[far.key]?.label;
    const page = names.pageNames[far.page];
    const module = names.moduleNames[far.moduleId] ?? far.moduleId;
    const port = names.portLabels?.[portLabelKey(far.moduleId, far.portId)] ?? far.portId;
    return [tag, page, `${module}/${port}`].filter(Boolean).join(' · ');
}

// Channel maps apply to both audio transports (as on the wire menu, useEdgeMenu).
const isAudio = (streamType: string | null | undefined) =>
    streamType === 'audio/pcm' || streamType === 'audio/302m';

const divider: MenuItem = { label: '', action: '', divider: true };

const icons = {
    goto: '<circle cx="12" cy="12" r="10"/><polyline points="12 16 16 12 12 8"/><line x1="8" y1="12" x2="16" y2="12"/>',
    wire: '<path d="M4 12h16"/><circle cx="4" cy="12" r="2"/><circle cx="20" cy="12" r="2"/>',
    unlink: '<path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};

function linkItems(ref: RefNode, link: RefLink, ctx: XrefMenuContext): MenuItem[] {
    const far = counterpartOf(ref, link);
    const id = link.connectionId;
    const items: MenuItem[] = [
        { label: counterpartLabel(ref, link, ctx), action: `goto:${far.key}`, icon: icons.goto },
    ];
    // The feed's type: an input tag's links may come from different outputs.
    const feedType = ctx.refs[link.outKey]?.streamType ?? ref.streamType;
    if (isAudio(feedType)) {
        items.push({ label: 'Channel map…', action: `chmap:${id}`, icon: menuIcons.channelMap });
    }
    items.push({ label: 'Edit label…', action: `label:${id}`, icon: menuIcons.editLabel });
    if (link.tagged && !link.readOnly && link.sourcePage === link.sinkPage) {
        items.push({ label: 'Show as wire', action: `wire:${id}`, icon: icons.wire });
    }
    if (!link.readOnly && !ref.readOnly) {
        items.push({ label: 'Unlink…', action: `unlink:${id}`, icon: icons.unlink, danger: true });
    }
    return items;
}

/**
 * The tag dropdown (XrefMenuAction): per link a jump to the far tag and that
 * connection's channel map, label, "Show as wire" and unlink; then "Link to
 * another page…" while a port there can take it, and "Settings…". A read-only
 * tag (a PipeWire wire across pages, or an unknown port type) says why and
 * offers no link or unlink.
 */
export function buildXrefMenuItems(ref: RefNode, ctx: XrefMenuContext): MenuItem[] {
    const items: MenuItem[] = [];
    if (ref.readOnly) {
        const why =
            ref.streamType === 'audio/pcm'
                ? 'PipeWire wire across pages: move these modules together'
                : 'Unknown port type: move these modules together';
        items.push({ label: why, action: 'readonly', disabled: true }, divider);
    }
    ref.links.forEach((link, i) => {
        if (i > 0) items.push(divider);
        items.push(...linkItems(ref, link, ctx));
    });
    if (items.length > 0 && !items[items.length - 1].divider) items.push(divider);
    if (ctx.hasCapacity && !ref.readOnly) {
        items.push({ label: 'Link to another page…', action: 'link', icon: icons.link });
    }
    items.push({ label: 'Settings…', action: 'settings', icon: menuIcons.settings });
    return items;
}
