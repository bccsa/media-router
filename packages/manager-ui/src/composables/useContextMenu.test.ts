/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { EngineState } from '@/stores/engines';

const mockCloneModule = vi.fn();
const mockModulesField = vi.fn();
const mockRemoveModules = vi.fn();
const mockEmit = vi.fn();

vi.mock('@/composables/usePatch', () => ({
    patch: {
        cloneModule: (...args: unknown[]) => mockCloneModule(...args),
        modulesField: (...args: unknown[]) => mockModulesField(...args),
        removeModules: (...args: unknown[]) => mockRemoveModules(...args),
    },
}));

vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ emit: (...args: unknown[]) => mockEmit(...args) }),
}));

import { useContextMenu } from './useContextMenu';

function makeEngine(): EngineState {
    const mod = (id: string, enabled = true) => ({
        instanceId: id,
        pluginId: 'audio-input',
        displayName: id,
        running: false,
        enabled,
        settings: {},
        ports: [],
    });
    return {
        engineId: 'eng-1',
        modules: { a: mod('a'), b: mod('b', false), c: mod('c') },
        connections: [],
    } as unknown as EngineState;
}

function setup(selected: string[] = [], focusedIds: string[] = []) {
    const engine = computed(() => makeEngine());
    const focused = computed(() => new Set(focusedIds));
    const requestDelete = vi.fn();
    const menu = useContextMenu(() => 'eng-1', engine, focused, {
        selectedIds: () => selected,
        requestDelete,
    });
    return { menu, requestDelete };
}

const rightClick = (id: string) => ({
    event: { preventDefault() {}, clientX: 5, clientY: 6 } as unknown as MouseEvent,
    node: { id } as never,
});

beforeEach(() => {
    setActivePinia(createPinia());
    for (const m of [mockCloneModule, mockModulesField, mockRemoveModules, mockEmit]) m.mockReset();
});

describe('useContextMenu clone action (#675)', () => {
    it('opens the settings panel on the cloned module', () => {
        mockCloneModule.mockReturnValue('audio-input-copy');
        const { menu } = setup();
        menu.onNodeContextMenu(rightClick('a'));

        menu.onContextAction('clone');

        expect(mockCloneModule).toHaveBeenCalledWith('eng-1', 'a');
        expect(menu.settingsPanel.value).toEqual({ moduleId: 'audio-input-copy' });
        expect(menu.contextMenu.value).toBeNull();
    });

    it('leaves the settings panel alone when the clone fails', () => {
        mockCloneModule.mockReturnValue(undefined);
        const { menu } = setup();
        menu.onNodeContextMenu(rightClick('a'));

        menu.onContextAction('clone');

        expect(menu.settingsPanel.value).toBeNull();
    });
});

describe('useContextMenu single module', () => {
    it('deletes a single module straight away (explicit menu pick)', () => {
        const { menu, requestDelete } = setup();
        menu.onNodeContextMenu(rightClick('c'));

        menu.onContextAction('delete');

        expect(mockRemoveModules).toHaveBeenCalledWith('eng-1', ['c']);
        expect(requestDelete).not.toHaveBeenCalled();
    });

    it('uses the single-module menu when the clicked node is outside the selection', () => {
        const { menu } = setup(['a', 'b']);
        menu.onNodeContextMenu(rightClick('c'));

        expect(menu.contextMenu.value?.targets).toEqual(['c']);
        expect(menu.contextMenuItems.value.some((i) => i.action === 'clone')).toBe(true);
    });
});

describe('useContextMenu group actions', () => {
    it('acts on the selection when the clicked node is part of it', () => {
        const { menu } = setup(['a', 'b']);
        menu.onNodeContextMenu(rightClick('a'));

        expect(menu.contextMenu.value?.targets).toEqual(['a', 'b']);
        expect(menu.contextMenuItems.value[0].label).toBe('2 modules selected');
    });

    it('opens the group menu from the selection rectangle', () => {
        const { menu } = setup();
        menu.onSelectionContextMenu({
            event: { preventDefault() {}, clientX: 1, clientY: 2 } as unknown as MouseEvent,
            nodes: [{ id: 'a' }, { id: 'c' }] as never,
        });

        expect(menu.contextMenu.value?.targets).toEqual(['a', 'c']);
    });

    it('opens the group menu at a point (touch long-press)', () => {
        const { menu } = setup();
        menu.openGroupMenuAt(3, 4, ['a', 'b']);

        expect(menu.contextMenu.value).toEqual({ x: 3, y: 4, targets: ['a', 'b'] });
    });

    it.each([
        ['enable', 'enabled', true],
        ['disable', 'enabled', false],
        ['focus', 'focused', true],
        ['unfocus', 'focused', false],
    ])('%s sets %s=%s on every selected module in one patch', (action, field, value) => {
        const { menu } = setup(['a', 'c']);
        menu.onNodeContextMenu(rightClick('a'));

        menu.onContextAction(action);

        expect(mockModulesField).toHaveBeenCalledTimes(1);
        expect(mockModulesField).toHaveBeenCalledWith('eng-1', ['a', 'c'], field, value);
    });

    it('greys out Enable all when every selected module is already enabled', () => {
        const { menu } = setup(['a', 'c']);
        menu.onNodeContextMenu(rightClick('a'));

        const item = (a: string) => menu.contextMenuItems.value.find((i) => i.action === a);
        expect(item('enable')?.disabled).toBe(true);
        expect(item('disable')?.disabled).toBe(false);
    });

    it('offers Default all only when every selected module is focused', () => {
        const { menu } = setup(['a', 'c'], ['a', 'c']);
        menu.onNodeContextMenu(rightClick('a'));

        const actions = menu.contextMenuItems.value.map((i) => i.action);
        expect(actions).toContain('unfocus');
        expect(actions).not.toContain('focus');
    });

    it('restarts every selected module', () => {
        const { menu } = setup(['a', 'b', 'c']);
        menu.onNodeContextMenu(rightClick('b'));

        menu.onContextAction('restart');

        expect(mockEmit).toHaveBeenCalledTimes(3);
        expect(mockEmit).toHaveBeenCalledWith('module:restart', { engineId: 'eng-1', moduleId: 'c' });
    });

    it('hands a group delete to the confirm instead of deleting', () => {
        const { menu, requestDelete } = setup(['a', 'b']);
        menu.onNodeContextMenu(rightClick('a'));

        menu.onContextAction('delete');

        expect(requestDelete).toHaveBeenCalledWith(['a', 'b']);
        expect(mockRemoveModules).not.toHaveBeenCalled();
    });
});
