import type { MenuItem } from '@/components/common/MrContextMenu.vue';
import type { PageEntry } from '@/utils/crossRefs';

/** Module and group menu actions that move the targets: `page:<pageId>` or `page:new`. */
export const PAGE_ACTION = 'page:';
/** Move target meaning "a page made for the move" (page ids are `pg-…`, so never this). */
export const NEW_PAGE = 'new';

const icons = {
    move: '<path d="M5 12h14" /><polyline points="12 5 19 12 12 19" />',
    newPage:
        '<rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />',
};

export interface PageMoveContext {
    /** Every page, in tab order. */
    pages: readonly PageEntry[];
    pageOf: (moduleId: string) => string;
    /** Why the modules can't move to the page (NEW_PAGE: a new one), or null. */
    refusal: (moduleIds: readonly string[], pageId: string) => string | null;
}

/**
 * "Move to <page>" for every page the modules are not all on already, then
 * "Move to new page". A move that would split a PipeWire wire across pages is
 * disabled, its reason as the tooltip.
 */
export function buildPageMoveItems(moduleIds: readonly string[], ctx: PageMoveContext): MenuItem[] {
    const item = (label: string, pageId: string, icon: string, tooltip: string): MenuItem => {
        const reason = ctx.refusal(moduleIds, pageId);
        return {
            label,
            action: PAGE_ACTION + pageId,
            icon,
            disabled: reason !== null,
            tooltip: reason ?? tooltip,
        };
    };
    const others = ctx.pages.filter((p) => !moduleIds.every((id) => ctx.pageOf(id) === p.id));
    return [
        ...others.map((p) =>
            item(
                `Move to ${p.name}`,
                p.id,
                icons.move,
                'Wires to modules on other pages show as tags',
            ),
        ),
        item(
            'Move to new page',
            NEW_PAGE,
            icons.newPage,
            'Add a page and move there; wires left behind show as tags',
        ),
    ];
}
