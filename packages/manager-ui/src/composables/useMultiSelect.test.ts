/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed, nextTick, ref, shallowRef } from 'vue';
import type { EngineState } from '@/stores/engines';

const flow = vi.hoisted(() => ({
    nodes: null as unknown as { value: Array<{ id: string }> },
    edges: null as unknown as { value: Array<{ id: string; source: string; target: string }> },
    clear: (() => {}) as () => void,
}));

vi.mock('@vue-flow/core', () => ({
    useVueFlow: () => ({
        getSelectedNodes: flow.nodes,
        getSelectedEdges: flow.edges,
        removeSelectedElements: () => flow.clear(),
    }),
}));

const mockRemoveModules = vi.fn();
vi.mock('@/composables/usePatch', () => ({
    patch: { removeModules: (...a: unknown[]) => mockRemoveModules(...a) },
}));

import { useMultiSelect } from './useMultiSelect';

const engine = computed(
    () =>
        ({
            modules: { a: { displayName: 'Mic 1' }, b: { displayName: 'Mic 2' } },
        }) as unknown as EngineState,
);

let container: HTMLDivElement;
let blocked = false;
const onEdgeDelete = vi.fn();
const clear = vi.fn();

function setup(nodes: string[], edges: Array<[string, string, string]> = []) {
    flow.nodes = shallowRef(nodes.map((id) => ({ id })));
    flow.edges = shallowRef(edges.map(([id, source, target]) => ({ id, source, target })));
    flow.clear = clear;
    return useMultiSelect({
        engineId: () => 'eng-1',
        engine,
        container: ref(container),
        isBlocked: () => blocked,
        onEdgeDelete,
        openGroupMenu: vi.fn(),
    });
}

const key = (k: string, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { key: k, cancelable: true });
    Object.defineProperty(e, 'target', { value: target });
    return e;
};

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    container = document.createElement('div');
    container.innerHTML = '<div class="vue-flow"><div class="vue-flow__node" tabindex="0"></div></div>';
    document.body.appendChild(container);
    blocked = false;
    for (const m of [onEdgeDelete, clear, mockRemoveModules]) m.mockReset();
});

afterEach(() => {
    container.remove();
    (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('useMultiSelect Delete key', () => {
    it('asks before deleting the selected modules', () => {
        const ms = setup(['a', 'b']);
        ms.onKeydown(key('Delete'));

        expect(ms.pendingDelete.value).toEqual({ modules: ['a', 'b'], edges: [] });
        expect(mockRemoveModules).not.toHaveBeenCalled();
        expect(ms.deleteTitle.value).toBe('Delete 2 modules?');
    });

    it('asks before deleting connections too (no instant edge delete)', () => {
        const ms = setup([], [['e1', 'a', 'b']]);
        ms.onKeydown(key('Backspace'));

        expect(onEdgeDelete).not.toHaveBeenCalled();
        expect(ms.pendingDelete.value).toEqual({ modules: [], edges: ['e1'] });
        expect(ms.deleteTitle.value).toBe('Delete 1 connection?');
        expect(ms.deleteMessage.value).toBe('The connection will be removed.');
    });

    it('lists loose connections with modules, but not edges of deleted modules', () => {
        const ms = setup(['a'], [['onA', 'a', 'x'], ['loose', 'x', 'y']]);
        ms.onKeydown(key('Delete'));

        expect(ms.pendingDelete.value).toEqual({ modules: ['a'], edges: ['loose'] });
        expect(ms.deleteTitle.value).toBe('Delete 1 module and 1 connection?');
    });

    it('names a single module and uses singular wording', () => {
        const ms = setup(['a']);
        ms.onKeydown(key('Delete'));

        expect(ms.deleteTitle.value).toBe('Delete Mic 1?');
        expect(ms.deleteMessage.value).toBe(
            'The module and all its connections will be removed permanently.',
        );
    });

    it('confirm removes modules in one patch and each loose connection', () => {
        const ms = setup(['a', 'b'], [['loose', 'x', 'y']]);
        ms.onKeydown(key('Delete'));
        ms.confirmDelete();

        expect(mockRemoveModules).toHaveBeenCalledWith('eng-1', ['a', 'b']);
        expect(onEdgeDelete).toHaveBeenCalledWith('loose');
        expect(ms.pendingDelete.value).toBeNull();
    });

    it('does nothing with nothing selected', () => {
        const ms = setup([]);
        const e = key('Delete');
        ms.onKeydown(e);

        expect(ms.pendingDelete.value).toBeNull();
        expect(e.defaultPrevented).toBe(false);
    });
});

describe('useMultiSelect key guards', () => {
    it('ignores keys typed into an input', () => {
        const ms = setup(['a']);
        ms.onKeydown(key('Backspace', document.createElement('input')));

        expect(ms.pendingDelete.value).toBeNull();
    });

    it('ignores keys while a toolbar button outside the canvas has focus', () => {
        const ms = setup(['a']);
        const btn = document.createElement('button');
        document.body.appendChild(btn);
        btn.focus();
        ms.onKeydown(key('Backspace', btn));

        expect(ms.pendingDelete.value).toBeNull();
        btn.remove();
    });

    it('accepts keys while a canvas node has focus', () => {
        const ms = setup(['a']);
        const node = container.querySelector<HTMLElement>('.vue-flow__node')!;
        node.focus();
        ms.onKeydown(key('Delete', node));

        expect(ms.pendingDelete.value).not.toBeNull();
    });

    it('ignores keys while a panel or dialog is open', () => {
        const ms = setup(['a']);
        blocked = true;
        ms.onKeydown(key('Delete'));
        ms.onKeydown(key('Escape'));

        expect(ms.pendingDelete.value).toBeNull();
        expect(clear).not.toHaveBeenCalled();
    });
});

describe('useMultiSelect selection clearing', () => {
    it('Escape clears the selection', () => {
        const ms = setup(['a']);
        ms.onKeydown(key('Escape'));

        expect(clear).toHaveBeenCalled();
    });

    it('Escape leaves the selection alone while the confirm is open (modal cancels)', () => {
        const ms = setup(['a']);
        ms.onKeydown(key('Delete'));
        ms.onKeydown(key('Escape'));

        expect(clear).not.toHaveBeenCalled();
        expect(ms.pendingDelete.value).not.toBeNull();
    });

    it('turning Select mode off clears the selection', async () => {
        const ms = setup(['a']);
        ms.selectMode.value = true;
        await nextTick();
        expect(clear).not.toHaveBeenCalled();

        ms.selectMode.value = false;
        await nextTick();
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it('counts the selected modules for the toolbar', () => {
        expect(setup(['a', 'b']).selectedCount.value).toBe(2);
    });
});
