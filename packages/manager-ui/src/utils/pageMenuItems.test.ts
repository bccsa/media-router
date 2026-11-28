import { describe, it, expect } from 'vitest';
import type { ModuleState } from '@/stores/engines';
import { buildGroupMenuItems, buildModuleMenuItems } from './moduleMenuItems';
import { buildPageMoveItems, NEW_PAGE, type PageMoveContext } from './pageMenuItems';

const pages = [
    { id: 'pg-1', name: 'Page 1', order: 0 },
    { id: 'pg-src', name: 'Sources', order: 1 },
    { id: 'pg-out', name: 'Outputs', order: 2 },
];
const onPage: Record<string, string> = { enc: 'pg-1', dec: 'pg-1', mic: 'pg-src' };

function ctx(refusals: Record<string, string> = {}): PageMoveContext {
    return {
        pages,
        pageOf: (id) => onPage[id],
        refusal: (_ids, pageId) => refusals[pageId] ?? null,
    };
}

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe('buildPageMoveItems', () => {
    it('offers every other page in tab order, then a new page', () => {
        const items = buildPageMoveItems(['enc'], ctx());
        expect(labels(items)).toEqual(['Move to Sources', 'Move to Outputs', 'Move to new page']);
        expect(items.map((i) => i.action)).toEqual(['page:pg-src', 'page:pg-out', 'page:new']);
        expect(items.every((i) => !i.disabled && !!i.icon && !!i.tooltip)).toBe(true);
    });

    it('a group spread over pages can go to any page', () => {
        expect(labels(buildPageMoveItems(['enc', 'mic'], ctx()))).toEqual([
            'Move to Page 1',
            'Move to Sources',
            'Move to Outputs',
            'Move to new page',
        ]);
    });

    it('disables a move that splits a PipeWire wire, the reason as its tooltip', () => {
        const reason = 'Would split the PipeWire wire MIC → SPK across pages';
        const items = buildPageMoveItems(['enc'], ctx({ 'pg-out': reason, [NEW_PAGE]: reason }));
        const out = items.find((i) => i.action === 'page:pg-out')!;
        expect(out).toMatchObject({ disabled: true, tooltip: reason });
        expect(items.find((i) => i.action === 'page:new')).toMatchObject({ disabled: true });
        expect(items.find((i) => i.action === 'page:pg-src')?.disabled).toBe(false);
    });

    it('a single page offers only the new page', () => {
        const only = { ...ctx(), pages: [pages[0]] };
        expect(labels(buildPageMoveItems(['enc'], only))).toEqual(['Move to new page']);
    });
});

describe('module and group menus with page moves', () => {
    const mod = {
        instanceId: 'enc',
        displayName: 'Encoder',
        enabled: true,
        settings: {},
    } as unknown as ModuleState;
    const moves = buildPageMoveItems(['enc'], ctx());

    it('puts the moves in their own section just before Delete', () => {
        for (const items of [
            buildModuleMenuItems(mod, false, moves),
            buildGroupMenuItems([mod, mod], false, moves),
        ]) {
            const del = items.findIndex((i) => i.action === 'delete');
            expect(items.slice(del - 5, del).map((i) => i.action)).toEqual([
                '',
                'page:pg-src',
                'page:pg-out',
                'page:new',
                '',
            ]);
            expect(items[del - 5].divider && items[del - 1].divider).toBe(true);
        }
    });

    it('leaves the menus as they were without page items', () => {
        const items = buildModuleMenuItems(mod, false);
        expect(items.some((i) => i.action.startsWith('page:'))).toBe(false);
        // Never two dividers in a row.
        expect(items.some((i, k) => i.divider && items[k + 1]?.divider)).toBe(false);
    });
});
