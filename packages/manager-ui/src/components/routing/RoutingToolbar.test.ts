// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import type { EngineState } from '@/stores/engines';

vi.mock('@/utils/engineActions', () => ({ engineActions: { setRunning: vi.fn() } }));

import RoutingToolbar from './RoutingToolbar.vue';
import type { RoutingUi } from './RoutingOverlays.vue';

const engine = {
    engineId: 'eng-1',
    running: false,
    interlocks: [],
    modules: {
        mic: { instanceId: 'mic', displayName: 'Mic 1', pluginId: 'audio-input', health: 'ok' },
        enc: { instanceId: 'enc', displayName: 'Encoder', pluginId: 'srt-output', health: 'error' },
    },
} as unknown as EngineState;

let wrapper: VueWrapper<any> | undefined;
afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
});

function setup() {
    const ui = reactive<RoutingUi>({
        showAddPanel: false,
        showModuleList: false,
        showLogs: false,
        showResetConfirm: false,
        showInterlocks: false,
    });
    wrapper = mount(RoutingToolbar, {
        props: {
            engineId: 'eng-1',
            engine,
            ui,
            selectedCount: 0,
            focusMode: false,
            selectMode: false,
        },
        global: { stubs: { RouterLink: true } },
    });
    return { w: wrapper, ui };
}

const button = (w: VueWrapper<any>, text: string) =>
    w.findAll('button').find((b) => b.text().startsWith(text))!;
const bodyButtons = () => Array.from(document.body.querySelectorAll('button'));

describe('RoutingToolbar', () => {
    it('emits its canvas actions and flips its panel flags', async () => {
        const { w, ui } = setup();
        await button(w, '+ Add Module').trigger('click');
        await button(w, 'Fit View').trigger('click');
        await button(w, 'Format').trigger('click');
        await button(w, 'Focus').trigger('click');
        await button(w, 'Select').trigger('click');
        await button(w, 'Logs').trigger('click');
        await button(w, 'Interlocks').trigger('click');
        await button(w, 'Reset').trigger('click');

        expect(w.emitted('toggleAdd')).toHaveLength(1);
        expect(w.emitted('fit')).toHaveLength(1);
        expect(w.emitted('format')).toHaveLength(1);
        expect(w.emitted('update:focusMode')).toEqual([[true]]);
        expect(w.emitted('update:selectMode')).toEqual([[true]]);
        expect(ui).toMatchObject({ showLogs: true, showInterlocks: true, showResetConfirm: true });
    });

    it('the Modules finder searches every module and jumps to the picked one', async () => {
        const { w, ui } = setup();
        await button(w, 'Modules (2)').trigger('click');
        expect(ui.showModuleList).toBe(true);
        await nextTick();

        const search = document.body.querySelector('input') as HTMLInputElement;
        search.value = 'srt';
        search.dispatchEvent(new Event('input'));
        await nextTick();
        const rows = bodyButtons().filter((b) => b.textContent?.includes('srt-output'));
        expect(rows).toHaveLength(1);
        expect(bodyButtons().some((b) => b.textContent?.includes('Mic 1'))).toBe(false);

        rows[0].click();
        expect(w.emitted('focusModule')).toEqual([['enc']]);
        expect(ui.showModuleList).toBe(false);
    });

    it('a second click on Modules closes the list', async () => {
        const { w, ui } = setup();
        await button(w, 'Modules').trigger('click');
        await nextTick();
        await button(w, 'Modules').trigger('click');
        expect(ui.showModuleList).toBe(false);
    });
});
