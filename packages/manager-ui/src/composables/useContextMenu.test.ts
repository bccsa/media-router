/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { EngineState } from '@/stores/engines';

const mockCloneModule = vi.fn();

vi.mock('@/composables/usePatch', () => ({
    patch: {
        cloneModule: (...args: unknown[]) => mockCloneModule(...args),
        moduleToggle: vi.fn(),
        removeModule: vi.fn(),
    },
}));

vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ emit: vi.fn() }),
}));

import { useContextMenu } from './useContextMenu';

function makeEngine(): EngineState {
    return {
        engineId: 'eng-1',
        modules: {
            'mod-src': {
                instanceId: 'mod-src',
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                running: false,
                enabled: true,
                settings: {},
                ports: [],
            },
        },
        connections: [],
    } as unknown as EngineState;
}

function setup() {
    const engine = computed(() => makeEngine());
    const focused = computed(() => new Set<string>());
    const menu = useContextMenu(
        () => 'eng-1',
        engine,
        focused,
        () => {},
    );
    menu.contextMenu.value = { x: 0, y: 0, moduleId: 'mod-src' };
    return menu;
}

describe('useContextMenu clone action (#675)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockCloneModule.mockReset();
    });

    it('opens the settings panel on the cloned module', () => {
        mockCloneModule.mockReturnValue('audio-input-copy');
        const menu = setup();

        menu.onContextAction('clone');

        expect(mockCloneModule).toHaveBeenCalledWith('eng-1', 'mod-src');
        expect(menu.settingsPanel.value).toEqual({ moduleId: 'audio-input-copy' });
        expect(menu.contextMenu.value).toBeNull();
    });

    it('leaves the settings panel alone when the clone fails', () => {
        mockCloneModule.mockReturnValue(undefined);
        const menu = setup();

        menu.onContextAction('clone');

        expect(menu.settingsPanel.value).toBeNull();
    });
});
