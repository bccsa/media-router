// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import PageTabs from './PageTabs.vue';
import PageDeleteDialog from './PageDeleteDialog.vue';
import MrContextMenu from '@/components/common/MrContextMenu.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import type { PageTab } from '@/utils/crossRefTypes';

const pages: PageTab[] = [
    { id: 'pg-a', name: 'Ingest', moduleCount: 4 },
    { id: 'pg-b', name: 'Studio', moduleCount: 1 },
    { id: 'pg-c', name: 'Return', moduleCount: 0 },
];

let mounted: VueWrapper | null = null;
function mountTabs(list: PageTab[] = pages, currentId = 'pg-a') {
    mounted = mount(PageTabs, {
        props: { pages: list, currentId },
        global: { stubs: { Teleport: true } },
        attachTo: document.body,
    });
    return mounted;
}
afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.useRealTimers();
});

const tabs = (w: VueWrapper) => w.findAll('[data-test="tab"]');

async function startRename(w: VueWrapper, index: number) {
    await tabs(w)[index].trigger('dblclick');
    return w.get('input');
}
async function type(w: VueWrapper, text: string) {
    const input = w.get('input');
    (input.element as HTMLInputElement).value = text;
    await input.trigger('input');
}

async function openMenu(w: VueWrapper, index: number) {
    await tabs(w)[index].trigger('contextmenu', { clientX: 30, clientY: 40 });
    return w.getComponent(MrContextMenu);
}
// By the label span: a disabled item's tooltip text sits in the same button.
const item = (menu: { findAll(selector: string): DOMWrapper<Element>[] }, label: string) =>
    menu.findAll('button').find((b) => b.find('span').text() === label)!;

describe('PageTabs', () => {
    it('shows each page name with its module count and marks the current one', () => {
        const w = mountTabs(pages, 'pg-b');
        expect(tabs(w).map((t) => t.find('span').text())).toEqual(['Ingest', 'Studio', 'Return']);
        expect(w.findAll('[data-test="count"]').map((c) => c.text())).toEqual(['4', '1', '0']);
        expect(tabs(w).map((t) => t.attributes('aria-selected'))).toEqual([
            'false',
            'true',
            'false',
        ]);
        expect(tabs(w)[1].classes()).toContain('border-accent');
    });

    it('selects another page and adds one', async () => {
        const w = mountTabs();
        await tabs(w)[0].trigger('click');
        await tabs(w)[2].trigger('click');
        await w.get('[data-test="add"]').trigger('click');
        expect(w.emitted('select')).toEqual([['pg-c']]);
        expect(w.emitted('add')).toHaveLength(1);
    });

    it('renames on double-click and Enter, trimmed', async () => {
        const w = mountTabs();
        const input = await startRename(w, 1);
        expect((input.element as HTMLInputElement).value).toBe('Studio');
        await type(w, '  Studio A ');
        await w.get('input').trigger('keydown', { key: 'Enter' });
        expect(w.emitted('rename')).toEqual([['pg-b', 'Studio A']]);
        expect(w.find('input').exists()).toBe(false);
    });

    it('shows a clash live and commits nothing until the name is valid', async () => {
        const w = mountTabs();
        await startRename(w, 1);
        await type(w, 'ingest');
        expect(w.text()).toContain('Another page already has this name');
        await w.get('input').trigger('keydown', { key: 'Enter' });
        expect(w.emitted('rename')).toBeUndefined();
        expect(w.find('input').exists()).toBe(true);
        await type(w, '');
        expect(w.text()).toContain('A page needs a name');
        await type(w, 'x'.repeat(41));
        expect(w.text()).toContain('At most 40 characters');
    });

    it('cancels on Escape', async () => {
        const w = mountTabs();
        await startRename(w, 1);
        await type(w, 'Other');
        await w.get('input').trigger('keydown', { key: 'Escape' });
        expect(w.find('input').exists()).toBe(false);
        expect(w.emitted('rename')).toBeUndefined();
        expect(tabs(w)[1].text()).toContain('Studio');
    });

    it('commits a valid name on leaving the box, drops an invalid one', async () => {
        const w = mountTabs();
        await startRename(w, 1);
        await type(w, 'Return');
        await w.get('input').trigger('focusout');
        expect(w.find('input').exists()).toBe(false);
        expect(w.emitted('rename')).toBeUndefined();

        await startRename(w, 1);
        await type(w, 'Gallery');
        await w.get('input').trigger('focusout');
        expect(w.emitted('rename')).toEqual([['pg-b', 'Gallery']]);
    });

    it('writes nothing for an unchanged name', async () => {
        const w = mountTabs();
        await startRename(w, 0);
        await w.get('input').trigger('keydown', { key: 'Enter' });
        expect(w.emitted('rename')).toBeUndefined();
    });

    it('right-click offers Rename, Move left/right and Delete, disabled at the ends', async () => {
        const w = mountTabs();
        let menu = await openMenu(w, 0);
        expect(menu.props('x')).toBe(30);
        expect(item(menu, 'Move left').attributes('disabled')).toBeDefined();
        expect(item(menu, 'Move right').attributes('disabled')).toBeUndefined();
        await item(menu, 'Move right').trigger('click');
        expect(w.emitted('move')).toEqual([['pg-a', 1]]);

        menu = await openMenu(w, 2);
        expect(item(menu, 'Move right').attributes('disabled')).toBeDefined();
        await item(menu, 'Move left').trigger('click');
        expect(w.emitted('move')).toEqual([
            ['pg-a', 1],
            ['pg-c', -1],
        ]);
    });

    it('renames from the menu', async () => {
        const w = mountTabs();
        const menu = await openMenu(w, 2);
        await item(menu, 'Rename').trigger('click');
        expect((w.get('input').element as HTMLInputElement).value).toBe('Return');
    });

    it('cannot delete the only page', async () => {
        const w = mountTabs([pages[0]]);
        const menu = await openMenu(w, 0);
        expect(item(menu, 'Delete…').attributes('disabled')).toBeDefined();
        expect(menu.text()).toContain('The only page cannot be deleted');
    });

    it('deletes after asking which page takes the modules', async () => {
        const w = mountTabs();
        const menu = await openMenu(w, 1);
        await item(menu, 'Delete…').trigger('click');
        const dialog = w.getComponent(PageDeleteDialog);
        expect(dialog.text()).toContain('Its 1 module move');
        const select = dialog.getComponent(MrSelect);
        // Defaults to the page on its left; the deleted page is not offered.
        expect(select.props('modelValue')).toBe('pg-a');
        expect(select.props('options').map((o: { value: string | number }) => o.value)).toEqual([
            'pg-a',
            'pg-c',
        ]);
        select.vm.$emit('update:modelValue', 'pg-c');
        await w.vm.$nextTick();
        await dialog.get('[data-test="confirm-delete"]').trigger('click');
        expect(w.emitted('delete')).toEqual([['pg-b', 'pg-c']]);
        expect(w.findComponent(PageDeleteDialog).exists()).toBe(false);
    });

    it('opens the menu on a long press', async () => {
        vi.useFakeTimers();
        const w = mountTabs();
        const touch = { clientX: 12, clientY: 34 };
        await tabs(w)[1].trigger('touchstart', { touches: [touch], changedTouches: [touch] });
        vi.advanceTimersByTime(600);
        await w.vm.$nextTick();
        const menu = w.getComponent(MrContextMenu);
        expect(menu.props()).toMatchObject({ x: 12, y: 34 });
        await item(menu, 'Move left').trigger('click');
        expect(w.emitted('move')).toEqual([['pg-b', -1]]);
    });
});
