import { describe, it, expect, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import type { EngineState } from '@/stores/engines';
import type { RefLink, RefNode } from '@/utils/crossRefTypes';
import type { CrossRefs } from './useCrossRefs';
import { useXrefUi, type XrefUiHooks } from './useXrefUi';

const link: RefLink = {
    connectionId: 'enc:out-dec:in',
    outKey: 'out:enc:out',
    inKey: 'in:dec:in',
    sourceModuleId: 'enc',
    sourcePortId: 'out',
    sinkModuleId: 'dec',
    sinkPortId: 'in',
    sourcePage: 'pg-1',
    sinkPage: 'pg-2',
    tagged: false,
    readOnly: false,
};
const tag = (key: string, kind: 'out' | 'in', moduleId: string, page: string): RefNode => ({
    key,
    kind,
    moduleId,
    portId: kind,
    page,
    streamType: 'audio/302m',
    color: '#06b6d4',
    readOnly: false,
    n: kind === 'out' ? 1 : 2,
    label: kind === 'out' ? '#1' : '#2',
    hint: '→ Outputs',
    capacity: -1,
    links: [link],
});

function setup(candidates = 1) {
    const refs = ref<Record<string, RefNode>>({
        'out:enc:out': tag('out:enc:out', 'out', 'enc', 'pg-1'),
        'in:dec:in': tag('in:dec:in', 'in', 'dec', 'pg-2'),
    });
    const crossRefs = {
        derived: computed(() => ({ directConnectionIds: [], links: [link], refs: refs.value })),
        pageNames: computed(() => ({ 'pg-1': 'Page 1', 'pg-2': 'Outputs' })),
        candidatesFor: vi.fn(() => Array.from({ length: candidates })),
        linkPicker: ref(null),
        pendingUnlink: ref(null),
        goToRef: vi.fn(),
        setTagged: vi.fn(),
        unlink: vi.fn(),
        openLinkPicker: vi.fn(),
        renameRef: vi.fn(),
        pickLink: vi.fn(),
        confirmUnlink: vi.fn(),
    };
    const engine = computed(
        () =>
            ({
                modules: {
                    enc: {
                        instanceId: 'enc',
                        displayName: 'Encoder',
                        ports: [{ id: 'out', label: 'Main' }],
                    },
                    dec: {
                        instanceId: 'dec',
                        displayName: 'Decoder',
                        ports: [{ id: 'in', label: 'In' }],
                    },
                },
            }) as unknown as EngineState,
    );
    const hooks: XrefUiHooks = {
        channelMap: vi.fn(),
        editLabel: vi.fn(),
        openModule: vi.fn(),
        closeModulePanel: vi.fn(),
    };
    const ui = useXrefUi(engine, crossRefs as unknown as CrossRefs, hooks);
    return { ui, crossRefs, hooks, refs };
}

describe('useXrefUi', () => {
    it("a tap opens the tag's dropdown: the far tag with its page and port, link actions, then link and settings", () => {
        const { ui } = setup();
        ui.openTagMenu('out:enc:out', 50, 60);
        expect(ui.tagMenu.value).toEqual({ x: 50, y: 60, key: 'out:enc:out' });
        const items = ui.tagMenuItems.value.filter((i) => !i.divider);
        expect(items[0]).toMatchObject({
            label: '#2 · Outputs · Decoder/In',
            action: 'goto:in:dec:in',
        });
        expect(items.map((i) => i.action)).toEqual([
            'goto:in:dec:in',
            'chmap:enc:out-dec:in',
            'label:enc:out-dec:in',
            'unlink:enc:out-dec:in',
            'link',
            'settings',
        ]);
    });

    it('offers no "Link to another page…" when no port on another page can take the link', () => {
        const { ui } = setup(0);
        ui.openTagMenu('out:enc:out', 0, 0);
        expect(ui.tagMenuItems.value.map((i) => i.action)).not.toContain('link');
    });

    it('routes each dropdown action, closing the dropdown', () => {
        const { ui, crossRefs, hooks } = setup();
        const pick = (action: string) => {
            ui.openTagMenu('out:enc:out', 5, 6);
            ui.onTagAction(action);
            expect(ui.tagMenu.value).toBeNull();
        };
        pick('goto:in:dec:in');
        expect(crossRefs.goToRef).toHaveBeenCalledWith('in:dec:in');
        pick('chmap:enc:out-dec:in');
        expect(hooks.channelMap).toHaveBeenCalledWith('enc:out-dec:in');
        pick('label:enc:out-dec:in');
        expect(hooks.editLabel).toHaveBeenCalledWith('enc:out-dec:in');
        pick('wire:enc:out-dec:in');
        expect(crossRefs.setTagged).toHaveBeenCalledWith('enc:out-dec:in', false);
        pick('unlink:enc:out-dec:in');
        expect(crossRefs.unlink).toHaveBeenCalledWith('enc:out-dec:in');
        pick('link');
        expect(crossRefs.openLinkPicker).toHaveBeenCalledWith(
            { moduleId: 'enc', portId: 'out', direction: 'output' },
            5,
            6,
        );
        pick('settings');
        expect(ui.xrefPanel.value).toBe('out:enc:out');
        expect(hooks.closeModulePanel).toHaveBeenCalled();
    });

    it('double-click opens the side panel and closes a dropdown a slow double-click opened', async () => {
        const { ui, refs } = setup();
        ui.openTagMenu('in:dec:in', 0, 0);
        ui.openPanel('in:dec:in');
        expect(ui.tagMenu.value).toBeNull();
        expect(ui.panelRef.value?.key).toBe('in:dec:in');

        // The tag goes away (unlinked elsewhere): its panel closes.
        const { 'in:dec:in': _gone, ...rest } = refs.value;
        refs.value = rest;
        await nextTick();
        expect(ui.xrefPanel.value).toBeNull();
    });

    it("the panel's module link closes the panel and shows the module", () => {
        const { ui, hooks } = setup();
        ui.openPanel('out:enc:out');
        ui.selectModule('enc');
        expect(ui.xrefPanel.value).toBeNull();
        expect(hooks.openModule).toHaveBeenCalledWith('enc');
    });

    it('is open while the dropdown, panel, picker or unlink confirm shows', () => {
        const { ui, crossRefs } = setup();
        expect(ui.isOpen.value).toBe(false);
        ui.openTagMenu('out:enc:out', 0, 0);
        expect(ui.isOpen.value).toBe(true);
        ui.tagMenu.value = null;
        ui.openPanel('out:enc:out');
        expect(ui.isOpen.value).toBe(true);
        ui.xrefPanel.value = null;
        crossRefs.linkPicker.value = { x: 0 } as never;
        expect(ui.isOpen.value).toBe(true);
        crossRefs.linkPicker.value = null;
        crossRefs.pendingUnlink.value = { connectionId: 'c' } as never;
        expect(ui.isOpen.value).toBe(true);
    });
});
