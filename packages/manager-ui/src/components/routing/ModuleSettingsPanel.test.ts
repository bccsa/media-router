// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const mockCloneModule = vi.fn();
vi.mock('@/composables/usePatch', () => ({
    patch: {
        cloneModule: (...args: unknown[]) => mockCloneModule(...args),
        moduleRename: vi.fn(),
        moduleToggle: vi.fn(),
        removeModule: vi.fn(),
    },
}));

import ModuleSettingsPanel from './ModuleSettingsPanel.vue';
import { useEngineStore } from '@/stores/engines';

/**
 * Seed one engine holding one module. No `configSchema` on purpose: that keeps
 * `requiredDeviceTypes` empty so the panel never reaches for the socket on
 * mount, and the form renders no fields.
 */
function seedEngine(mod: Record<string, unknown> = {}) {
    useEngineStore().addEngine({
        engine_id: 'eng-1',
        display_name: 'Test Engine',
        modules: {
            'audio-input-abc': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                ...mod,
            },
        },
    });
}

function mountPanel(moduleId = 'audio-input-abc') {
    return mount(ModuleSettingsPanel, { props: { engineId: 'eng-1', moduleId } });
}

describe('ModuleSettingsPanel', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockCloneModule.mockReset();
    });

    it('shows the plugin id alongside the editable display name', () => {
        seedEngine();
        const wrapper = mountPanel();

        expect(wrapper.text()).toContain('audio-input');
        // The name stays in the input, not the type line.
        expect(wrapper.get('input').element.value).toBe('Mic 1');
    });

    it('omits the type line when the module is unknown', () => {
        seedEngine();
        const wrapper = mountPanel('does-not-exist');

        expect(wrapper.text()).not.toContain('audio-input');
    });

    it('emits select with the clone id so the panel switches to the copy (#675)', async () => {
        seedEngine();
        mockCloneModule.mockReturnValue('audio-input-copy');
        const wrapper = mountPanel();

        const cloneBtn = wrapper.findAll('button').find((b) => b.text() === 'Clone');
        await cloneBtn!.trigger('click');

        expect(mockCloneModule).toHaveBeenCalledWith('eng-1', 'audio-input-abc');
        expect(wrapper.emitted('select')).toEqual([['audio-input-copy']]);
    });

    it('does not emit select when the clone fails', async () => {
        seedEngine();
        mockCloneModule.mockReturnValue(undefined);
        const wrapper = mountPanel();

        const cloneBtn = wrapper.findAll('button').find((b) => b.text() === 'Clone');
        await cloneBtn!.trigger('click');

        expect(wrapper.emitted('select')).toBeUndefined();
    });
});
