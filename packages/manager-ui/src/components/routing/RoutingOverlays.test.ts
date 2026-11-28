// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';

const mockReset = vi.fn(async () => {});
vi.mock('@/utils/engineActions', () => ({
    engineActions: { reset: (...args: unknown[]) => mockReset(...(args as [])) },
}));

import RoutingOverlays, { type RoutingUi } from './RoutingOverlays.vue';
import MrContextMenu from '@/components/common/MrContextMenu.vue';

function setup(xref?: { isOpen: boolean }) {
    const ui = reactive<RoutingUi>({
        showAddPanel: false,
        showModuleList: false,
        showLogs: false,
        showResetConfirm: false,
        showInterlocks: false,
    });
    // Only what the host reads; the real objects are reactive(useContextMenu/useMultiSelect).
    const menu = reactive({
        contextMenu: null as unknown,
        edgeContextMenu: null as unknown,
        settingsPanel: null as unknown,
        editingEdgeLabel: null as unknown,
        channelMapEdge: null as unknown,
        contextMenuItems: [],
        edgeMenuItems: [],
        onContextAction: vi.fn(),
        onContextSliderChange: vi.fn(),
        onContextToggleChange: vi.fn(),
        onEdgeContextAction: vi.fn(),
        saveEdgeLabel: vi.fn(),
    });
    const multi = reactive({
        pendingDelete: null as unknown,
        deleteTitle: '',
        deleteMessage: '',
        confirmDelete: vi.fn(),
    });
    const wrapper = mount(RoutingOverlays, {
        props: {
            engineId: 'eng-1',
            ui,
            menu: menu as never,
            multi: multi as never,
            xref: xref && (reactive(xref) as never),
        },
        global: {
            stubs: {
                LogViewer: true,
                AddModulePanel: true,
                InterlockPanel: true,
                ModuleSettingsPanel: true,
                ChannelMapEditor: true,
                EdgeLabelEditor: true,
                MrContextMenu: true,
                XrefOverlays: true,
            },
        },
    });
    return { wrapper, ui, menu, multi };
}

let wrapper: VueWrapper | undefined;
beforeEach(() => mockReset.mockClear());
afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
});

describe('RoutingOverlays isBlocked', () => {
    it('is false while nothing is open', () => {
        const s = setup();
        wrapper = s.wrapper;
        expect(s.wrapper.vm.isBlocked()).toBe(false);
    });

    it.each([
        ['menu', 'contextMenu', { x: 0, y: 0, targets: ['a'] }],
        ['menu', 'edgeContextMenu', { x: 0, y: 0, edgeId: 'e' }],
        ['menu', 'settingsPanel', { moduleId: 'a' }],
        ['menu', 'editingEdgeLabel', { edgeId: 'e', label: '' }],
        ['menu', 'channelMapEdge', 'e'],
        ['ui', 'showAddPanel', true],
        ['ui', 'showInterlocks', true],
        ['ui', 'showResetConfirm', true],
        ['ui', 'showModuleList', true],
    ])('is true while %s.%s is open', (owner, key, value) => {
        const s = setup();
        wrapper = s.wrapper;
        (owner === 'menu' ? s.menu : s.ui)[key as never] = value as never;
        expect(s.wrapper.vm.isBlocked()).toBe(true);
    });

    it('is true while a tag dropdown, tag panel, link picker or unlink confirm is open', () => {
        const s = setup({ isOpen: true });
        wrapper = s.wrapper;
        expect(s.wrapper.findComponent({ name: 'XrefOverlays' }).exists()).toBe(true);
        expect(s.wrapper.vm.isBlocked()).toBe(true);
        const closed = setup({ isOpen: false });
        expect(closed.wrapper.vm.isBlocked()).toBe(false);
        closed.wrapper.unmount();
    });

    it('leaves the canvas keys alone for the log drawer and the delete confirm', () => {
        const s = setup();
        wrapper = s.wrapper;
        s.ui.showLogs = true;
        s.multi.pendingDelete = { modules: ['a'], edges: [] };
        expect(s.wrapper.vm.isBlocked()).toBe(false);
    });
});

describe('RoutingOverlays actions', () => {
    it('an edge menu Delete goes out as edgeDelete', async () => {
        const s = setup();
        wrapper = s.wrapper;
        s.menu.edgeContextMenu = { x: 1, y: 2, edgeId: 'e1' };
        await nextTick();
        s.wrapper.findAllComponents(MrContextMenu)[0].vm.$emit('action', 'delete');

        expect(s.menu.onEdgeContextAction).toHaveBeenCalledWith('delete', expect.any(Function));
        const onDelete = s.menu.onEdgeContextAction.mock.calls[0][1] as (id: string) => void;
        onDelete('e1');
        expect(s.wrapper.emitted('edgeDelete')).toEqual([['e1']]);
    });

    it('the reset confirm resets the engine and closes', async () => {
        const s = setup();
        wrapper = s.wrapper;
        s.ui.showResetConfirm = true;
        await nextTick();
        const reset = Array.from(document.body.querySelectorAll('button')).find(
            (b) => b.textContent?.trim() === 'Reset',
        );
        reset!.click();

        expect(mockReset).toHaveBeenCalledWith('eng-1');
        expect(s.ui.showResetConfirm).toBe(false);
    });

    it("the settings panel's Clone switches the panel to the copy and reports it", async () => {
        const s = setup();
        wrapper = s.wrapper;
        s.menu.settingsPanel = { moduleId: 'a' };
        await nextTick();
        s.wrapper.findComponent({ name: 'ModuleSettingsPanel' }).vm.$emit('select', 'a-copy');

        expect(s.menu.settingsPanel).toEqual({ moduleId: 'a-copy' });
        expect(s.wrapper.emitted('panelSelect')).toEqual([['a-copy']]);
    });
});
