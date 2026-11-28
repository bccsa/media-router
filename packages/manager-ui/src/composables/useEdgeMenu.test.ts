import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { EngineState } from '@/stores/engines';

const mockConnectionField = vi.fn();
vi.mock('@/composables/usePatch', () => ({
    patch: { connectionField: (...args: unknown[]) => mockConnectionField(...args) },
}));
vi.mock('@/stores/socket', () => ({ useSocketStore: () => ({ call: vi.fn() }) }));

import { useEdgeMenu } from './useEdgeMenu';
import { useContextMenu } from './useContextMenu';

const mod = (id: string, streamType: string) => ({
    instanceId: id,
    ports: [
        { id: 'out', direction: 'output', streamType },
        { id: 'in', direction: 'input', streamType },
    ],
});

/** `aud` is a labelled 302M wire, `ts` an unlabelled MPEG-TS one. */
function makeEngine(): EngineState {
    return {
        engineId: 'eng-1',
        modules: {
            a: mod('a', 'audio/302m'),
            b: mod('b', 'audio/302m'),
            t: mod('t', 'muxed/mpegts'),
        },
        connections: [
            {
                id: 'aud',
                sourceModuleId: 'a',
                sourcePortId: 'out',
                sinkModuleId: 'b',
                sinkPortId: 'in',
                label: 'Main',
            },
            {
                id: 'ts',
                sourceModuleId: 't',
                sourcePortId: 'out',
                sinkModuleId: 't',
                sinkPortId: 'in',
            },
        ],
    } as unknown as EngineState;
}

const click = (edgeId: string) => ({
    event: { preventDefault: vi.fn(), clientX: 10, clientY: 20 },
    edge: { id: edgeId },
});

function setup() {
    const onClickOpen = vi.fn();
    const menu = useEdgeMenu(() => 'eng-1', computed(makeEngine), onClickOpen);
    return { menu, onClickOpen };
}

beforeEach(() => mockConnectionField.mockReset());

describe('useEdgeMenu', () => {
    it('a click opens the menu at the pointer and reports the open', () => {
        const { menu, onClickOpen } = setup();
        menu.onEdgeClick(click('aud'));
        expect(menu.edgeContextMenu.value).toEqual({ x: 10, y: 20, edgeId: 'aud' });
        expect(onClickOpen).toHaveBeenCalledTimes(1);
    });

    it('a right-click opens it too, without the browser menu, and reports nothing', () => {
        const { menu, onClickOpen } = setup();
        const p = click('aud');
        menu.onEdgeContextMenu(p);
        expect(p.event.preventDefault).toHaveBeenCalled();
        expect(menu.edgeContextMenu.value?.edgeId).toBe('aud');
        expect(onClickOpen).not.toHaveBeenCalled();
    });

    it('offers Channel Map on audio wires only', () => {
        const { menu } = setup();
        const actions = () => menu.edgeMenuItems.value.map((i) => i.action);
        menu.onEdgeClick(click('aud'));
        expect(actions()).toContain('channelMap');
        menu.onEdgeClick(click('ts'));
        expect(actions()).not.toContain('channelMap');
        expect(actions()).toEqual(expect.arrayContaining(['editLabel', 'delete']));
    });

    it('Edit Label opens the editor on the current label; saving writes it and closes', () => {
        const { menu } = setup();
        menu.onEdgeClick(click('aud'));
        menu.onEdgeContextAction('editLabel', vi.fn());
        expect(menu.editingEdgeLabel.value).toEqual({ edgeId: 'aud', label: 'Main' });
        expect(menu.edgeContextMenu.value).toBeNull();

        menu.editingEdgeLabel.value!.label = 'Backup';
        menu.saveEdgeLabel();
        expect(mockConnectionField).toHaveBeenCalledWith('eng-1', 'aud', 'label', 'Backup');
        expect(menu.editingEdgeLabel.value).toBeNull();
    });

    it('Channel Map opens the editor for the wire', () => {
        const { menu } = setup();
        menu.onEdgeClick(click('aud'));
        menu.onEdgeContextAction('channelMap', vi.fn());
        expect(menu.channelMapEdge.value).toBe('aud');
    });

    it('Delete hands the wire to the caller; nothing happens without an open menu', () => {
        const { menu } = setup();
        const onDelete = vi.fn();
        menu.onEdgeContextAction('delete', onDelete);
        expect(onDelete).not.toHaveBeenCalled();

        menu.onEdgeClick(click('ts'));
        menu.onEdgeContextAction('delete', onDelete);
        expect(onDelete).toHaveBeenCalledWith('ts');
        expect(menu.edgeContextMenu.value).toBeNull();
    });
});

describe('useEdgeMenu inside useContextMenu', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.useFakeTimers();
    });
    afterEach(() => vi.useRealTimers());

    it('a clicked edge menu survives the pane click of that same click, then closes on the next', () => {
        const menu = useContextMenu(
            () => 'eng-1',
            computed(makeEngine),
            computed(() => new Set<string>()),
        );
        menu.onEdgeClick(click('aud'));
        menu.dismissContextMenus();
        expect(menu.edgeContextMenu.value?.edgeId).toBe('aud');

        vi.advanceTimersByTime(300);
        menu.dismissContextMenus();
        expect(menu.edgeContextMenu.value).toBeNull();
    });
});
