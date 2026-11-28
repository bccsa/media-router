// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import XrefOverlays from './XrefOverlays.vue';

function setup() {
    // Only what the overlay reads; the real object is reactive(useXrefUi(…)).
    const xref = reactive({
        tagMenu: null as { x: number; y: number; key: string } | null,
        tagMenuItems: [{ label: 'Settings…', action: 'settings' }],
        xrefPanel: null as string | null,
        panelRef: undefined as unknown,
        refs: {},
        pageNames: { 'pg-1': 'Page 1' },
        moduleNames: { enc: 'Encoder' },
        portLabels: {},
        linkPicker: null as unknown,
        pendingUnlink: null as unknown,
        onTagAction: vi.fn(),
        renameRef: vi.fn(),
        goToRef: vi.fn(),
        unlink: vi.fn(),
        selectModule: vi.fn(),
        pickLink: vi.fn(),
        confirmUnlink: vi.fn(),
    });
    const wrapper = mount(XrefOverlays, {
        props: { xref: xref as never },
        global: {
            stubs: { MrContextMenu: true, XrefSettingsPanel: true, XrefLinkPicker: true },
        },
    });
    return { wrapper, xref };
}

let wrapper: VueWrapper | undefined;
afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
});

describe('XrefOverlays', () => {
    it('shows nothing while closed', () => {
        const s = setup();
        wrapper = s.wrapper;
        expect(s.wrapper.html()).not.toContain('stub');
    });

    it('the tag dropdown routes its actions and closes', async () => {
        const s = setup();
        wrapper = s.wrapper;
        s.xref.tagMenu = { x: 1, y: 2, key: 'out:enc:out' };
        await nextTick();
        const menu = s.wrapper.findComponent({ name: 'MrContextMenu' });
        expect(menu.props()).toMatchObject({ x: 1, y: 2, items: s.xref.tagMenuItems });
        menu.vm.$emit('action', 'settings');
        expect(s.xref.onTagAction).toHaveBeenCalledWith('settings');
        menu.vm.$emit('close');
        expect(s.xref.tagMenu).toBeNull();
    });

    it("the tag's side panel renames, jumps, unlinks and shows its module", async () => {
        const s = setup();
        wrapper = s.wrapper;
        s.xref.xrefPanel = 'out:enc:out';
        s.xref.panelRef = { key: 'out:enc:out' };
        await nextTick();
        const panel = s.wrapper.findComponent({ name: 'XrefSettingsPanel' });
        expect(panel.props()).toMatchObject({
            refNode: { key: 'out:enc:out' },
            moduleNames: { enc: 'Encoder' },
        });
        panel.vm.$emit('rename', 'out:enc:out', 'Main');
        panel.vm.$emit('goto', 'in:dec:in');
        panel.vm.$emit('unlink', 'c1');
        panel.vm.$emit('selectModule', 'enc');
        expect(s.xref.renameRef).toHaveBeenCalledWith('out:enc:out', 'Main');
        expect(s.xref.goToRef).toHaveBeenCalledWith('in:dec:in');
        expect(s.xref.unlink).toHaveBeenCalledWith('c1');
        expect(s.xref.selectModule).toHaveBeenCalledWith('enc');
        panel.vm.$emit('close');
        expect(s.xref.xrefPanel).toBeNull();
    });

    it('the link picker picks and closes', async () => {
        const s = setup();
        wrapper = s.wrapper;
        const candidate = { moduleId: 'mix', portId: 'in' };
        s.xref.linkPicker = { x: 5, y: 6, candidates: [candidate] };
        await nextTick();
        const picker = s.wrapper.findComponent({ name: 'XrefLinkPicker' });
        expect(picker.props()).toMatchObject({ x: 5, y: 6, candidates: [candidate] });
        picker.vm.$emit('pick', candidate);
        expect(s.xref.pickLink).toHaveBeenCalledWith(candidate);
        picker.vm.$emit('close');
        expect(s.xref.linkPicker).toBeNull();
    });

    it('the unlink confirm names both ends; Unlink confirms, Cancel drops it', async () => {
        const s = setup();
        wrapper = s.wrapper;
        s.xref.pendingUnlink = {
            connectionId: 'c1',
            from: 'ENC/Out (Page 1)',
            to: 'DEC/In (Outputs)',
        };
        await nextTick();
        expect(document.body.textContent).toContain('ENC/Out (Page 1) → DEC/In (Outputs)');
        const button = (text: string) =>
            Array.from(document.body.querySelectorAll('button')).find(
                (b) => b.textContent?.trim() === text,
            )!;
        button('Unlink').click();
        expect(s.xref.confirmUnlink).toHaveBeenCalledTimes(1);
        button('Cancel').click();
        expect(s.xref.pendingUnlink).toBeNull();
    });
});
