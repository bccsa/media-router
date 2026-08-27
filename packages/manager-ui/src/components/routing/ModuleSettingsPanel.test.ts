// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
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
});
