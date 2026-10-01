import { describe, it, expect } from 'vitest';
import { newDashboard, type DashboardWidget } from '@media-router/shared-types';
import { modulePathOf, useDraft, modulePathsOf } from './useDraft';

const w = (id: string, x: number, y: number, bind?: string, extra: Partial<DashboardWidget> = {}): DashboardWidget => ({ id, type: 'fader', x, y, w: 2, h: 6, bind, ...extra });
const strip = () => ({
    ...newDashboard('Stage'),
    widgets: [w('a', 0, 0, '/modules/m1/settings/volume'), w('b', 2, 0, '/modules/m1/vu', { type: 'vu' }), w('c', 0, 6, undefined, { type: 'label', h: 1 })],
});

describe('useDraft', () => {
    it('adds a widget at the first free spot and selects it; edits mark the draft dirty', () => {
        const d = useDraft(strip());
        expect(d.dirty.value).toBe(false);
        const added = d.add('gauge')!;
        expect(added).toMatchObject({ type: 'gauge', x: 4, y: 0, w: 4, h: 2 });
        expect(d.selected.value).toEqual([added.id]);
        expect(d.dirty.value).toBe(true);
    });

    it('moves a selection together without leaving the grid, and resizes inside it', () => {
        const d = useDraft(strip());
        d.select('a');
        d.select('b', true);
        d.move(-5, 3);
        expect(d.draft.value.widgets.slice(0, 2).map((x) => [x.x, x.y])).toEqual([[0, 3], [2, 3]]);
        d.move(100, 100);
        expect(d.draft.value.widgets.slice(0, 2).map((x) => [x.x, x.y])).toEqual([[20, 8], [22, 8]]);
        d.resize('a', 50, 50);
        expect(d.draft.value.widgets[0]).toMatchObject({ x: 20, y: 8, w: 4, h: 6 });
    });

    it('Duplicate for… copies the selection beside it, tied to the other module', () => {
        const d = useDraft(strip());
        d.select('a');
        d.select('b', true);
        expect(d.selectionModule.value).toBe('/modules/m1');
        d.duplicateFor('/modules/m2');
        const copies = d.selection.value;
        expect(copies.map((x) => [x.bind, x.x, x.y])).toEqual([['/modules/m2/settings/volume', 4, 0], ['/modules/m2/vu', 6, 0]]);
        expect(copies.every((x) => !['a', 'b'].includes(x.id))).toBe(true);
    });

    it('a second Duplicate for… of the same strip goes to the next free slot, not on top of the first', () => {
        const d = useDraft(strip());
        for (const to of ['/modules/m2', '/modules/m3']) {
            d.select('a');
            d.select('b', true);
            d.duplicateFor(to);
        }
        const at = (m: string) => d.draft.value.widgets.filter((x) => x.bind?.startsWith(m)).map((x) => x.x);
        expect([at('/modules/m2'), at('/modules/m3')]).toEqual([[4, 6], [8, 10]]);
    });

    it('many duplicates fill the grid like text: the rest of the row, then the next rows', () => {
        const d = useDraft({ ...newDashboard('Board'), cols: 12, rows: 6, widgets: [w('a', 0, 0, '/modules/m0/health', { type: 'light', w: 4, h: 2 })] });
        for (let i = 1; i <= 8; i++) {
            d.select('a');
            d.duplicateFor(`/modules/m${i}`);
        }
        const spots = d.draft.value.widgets.map((x) => [x.x, x.y]);
        expect(spots).toEqual([[0, 0], [4, 0], [8, 0], [0, 2], [4, 2], [8, 2], [0, 4], [4, 4], [8, 4]]);
    });

    it('a selection on two modules has no single module to duplicate for', () => {
        const d = useDraft({ ...strip(), widgets: [w('a', 0, 0, '/modules/m1/vu'), w('b', 2, 0, '/modules/m2/vu')] });
        d.select('a');
        d.select('b', true);
        expect(d.selectionModule.value).toBeUndefined();
    });

    it('copy and paste make new widgets next to the originals', () => {
        const d = useDraft(strip());
        d.select('c');
        d.copy();
        d.paste();
        expect(d.draft.value.widgets).toHaveLength(4);
        expect(d.selection.value[0]).toMatchObject({ type: 'label', x: 2, y: 6 });
    });

    it('options drop empty values; input disabled false is dropped too', () => {
        const d = useDraft(strip());
        d.setOption('a', 'label', 'Vol');
        d.update('a', { inputDisabled: true });
        expect(d.draft.value.widgets[0]).toMatchObject({ options: { label: 'Vol' }, inputDisabled: true });
        d.setOption('a', 'label', '');
        d.update('a', { inputDisabled: false });
        expect(d.draft.value.widgets[0].options).toBeUndefined();
        expect('inputDisabled' in d.draft.value.widgets[0]).toBe(false);
    });

    it('frames go to the back; a smaller grid pulls widgets inside it', () => {
        const d = useDraft(strip());
        d.select('c');
        d.restack(false);
        expect(d.draft.value.widgets.map((x) => x.id)).toEqual(['c', 'a', 'b']);
        d.configure({ cols: 3, rows: 4 });
        expect(d.draft.value.widgets.every((x) => x.x + x.w <= 3 && x.y + x.h <= 4)).toBe(true);
    });

    it('finds the module of a value or an action', () => {
        expect(modulePathOf(w('a', 0, 0, '/engines/e1/modules/m9/settings/volume'))).toBe('/engines/e1/modules/m9');
        expect(modulePathOf({ ...w('a', 0, 0), action: { kind: 'call', path: '/modules/m3', method: 'restart' } })).toBe('/modules/m3');
        expect(modulePathOf(w('a', 0, 0, '/info/running'))).toBeUndefined();
    });
});

describe('modules of a widget', () => {
    it('a trend may span modules; Duplicate for… needs exactly one', () => {
        const trend = { id: 't', type: 'trend', x: 0, y: 0, w: 8, h: 5, binds: ['/modules/a/statusData/s/x', '/modules/b/statusData/s/y', '/modules/a/vu'] } as DashboardWidget;
        expect(modulePathsOf(trend)).toEqual(['/modules/a', '/modules/b']);
        expect(modulePathOf(trend)).toBeUndefined();
        expect(modulePathOf({ ...trend, binds: ['/modules/a/vu'] })).toBe('/modules/a');
    });
});
