/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { EngineState } from '@/stores/engines';
import type { MenuPages } from './useContextMenu';

const m = vi.hoisted(() => ({ clone: vi.fn(), editor: vi.fn() }));
vi.mock('@/composables/usePatch', () => ({
    patch: {
        cloneModule: (...a: unknown[]) => m.clone(...a),
        editor: (...a: unknown[]) => m.editor(...a),
    },
}));
vi.mock('@/stores/socket', () => ({ useSocketStore: () => ({ call: vi.fn() }) }));

import { useContextMenu } from './useContextMenu';

const mod = (id: string) => ({
    instanceId: id,
    displayName: id,
    enabled: true,
    settings: {},
    ports: [],
});
const engine = computed(
    () =>
        ({
            engineId: 'eng-1',
            modules: { mic: mod('mic'), spk: mod('spk'), enc: mod('enc') },
            connections: [],
        }) as unknown as EngineState,
);

const reason = 'Would split the PipeWire wire mic → spk across pages';

function setup(selected: string[] = []) {
    const pages: MenuPages = {
        pages: computed(() => [
            { id: 'pg-1', name: 'Page 1', order: 0 },
            { id: 'pg-out', name: 'Outputs', order: 1 },
        ]),
        pageOf: () => 'pg-1',
        moveRefusal: vi.fn((ids: readonly string[]) =>
            ids.includes('mic') && !ids.includes('spk') ? reason : null,
        ),
        moveModules: vi.fn(),
        newModuleOps: vi.fn((ids: readonly string[]) =>
            ids.map((id) => ({
                op: 'add' as const,
                path: `/editor/modulePages/${id}`,
                value: 'pg-1',
            })),
        ),
    };
    const menu = useContextMenu(
        () => 'eng-1',
        engine,
        computed(() => new Set<string>()),
        { selectedIds: () => selected, requestDelete: vi.fn() },
        pages,
    );
    return { menu, pages };
}

const rightClick = (id: string, type = 'module') => ({
    event: { preventDefault() {}, clientX: 5, clientY: 6 } as unknown as MouseEvent,
    node: { id, type } as never,
});
const pageItems = (items: Array<{ action: string }>) =>
    items.filter((i) => i.action.startsWith('page:'));

beforeEach(() => {
    setActivePinia(createPinia());
    m.clone.mockReset();
    m.editor.mockReset();
});

describe('useContextMenu page moves', () => {
    it('offers the other pages and a new page for one module', () => {
        const { menu } = setup();
        menu.onNodeContextMenu(rightClick('enc'));
        expect(pageItems(menu.contextMenuItems.value)).toMatchObject([
            { label: 'Move to Outputs', action: 'page:pg-out', disabled: false },
            { label: 'Move to new page', action: 'page:new', disabled: false },
        ]);
    });

    it('disables the moves that split a PipeWire wire, with the reason', () => {
        const { menu } = setup();
        menu.onNodeContextMenu(rightClick('mic'));
        for (const item of pageItems(menu.contextMenuItems.value))
            expect(item).toMatchObject({ disabled: true, tooltip: reason });
    });

    it('moves the whole selection to the picked page', () => {
        const { menu, pages } = setup(['mic', 'spk']);
        menu.onNodeContextMenu(rightClick('mic'));
        const items = pageItems(menu.contextMenuItems.value);
        expect(items.every((i) => !('disabled' in i) || i.disabled === false)).toBe(true);

        menu.onContextAction('page:pg-out');
        expect(pages.moveModules).toHaveBeenCalledWith(['mic', 'spk'], 'pg-out');
        expect(menu.contextMenu.value).toBeNull();

        menu.onNodeContextMenu(rightClick('enc'));
        menu.onContextAction('page:new');
        expect(pages.moveModules).toHaveBeenLastCalledWith(['enc'], 'new');
    });

    it('a clone lands on the page shown', () => {
        m.clone.mockReturnValue('enc-copy');
        const { menu } = setup();
        menu.onNodeContextMenu(rightClick('enc'));
        menu.onContextAction('clone');
        expect(m.editor).toHaveBeenCalledWith('eng-1', [
            { op: 'add', path: '/editor/modulePages/enc-copy', value: 'pg-1' },
        ]);
        expect(menu.settingsPanel.value).toEqual({ moduleId: 'enc-copy' });
    });

    it('opens no module menu on a node that is not a module', () => {
        const { menu } = setup();
        menu.onNodeContextMenu(rightClick('out:enc:out', 'xref'));
        expect(menu.contextMenu.value).toBeNull();
        menu.openGroupMenuAt(1, 2, ['enc', 'out:enc:out']);
        expect(menu.contextMenu.value?.targets).toEqual(['enc']);
    });
});
