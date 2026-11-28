import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { EngineState } from '@/stores/engines';

vi.mock('@/composables/usePatch', () => ({ patch: { connectionField: vi.fn() } }));
vi.mock('@/stores/socket', () => ({ useSocketStore: () => ({ call: vi.fn() }) }));

import { useEdgeMenu, type EdgeMenuRefs } from './useEdgeMenu';
import { useContextMenu } from './useContextMenu';

const mod = (id: string, streamType: string) => ({
    instanceId: id,
    ports: [
        { id: 'out', direction: 'output', streamType },
        { id: 'in', direction: 'input', streamType },
    ],
});
const conn = (id: string, src: string, sink: string) => ({
    id,
    sourceModuleId: src,
    sourcePortId: 'out',
    sinkModuleId: sink,
    sinkPortId: 'in',
});

/** 302M a → b, MPEG-TS t → u, PipeWire p → q. */
const engine = computed(
    () =>
        ({
            engineId: 'eng-1',
            modules: {
                a: mod('a', 'audio/302m'),
                b: mod('b', 'audio/302m'),
                t: mod('t', 'muxed/mpegts'),
                u: mod('u', 'muxed/mpegts'),
                p: mod('p', 'audio/pcm'),
                q: mod('q', 'audio/pcm'),
            },
            connections: [conn('aud', 'a', 'b'), conn('ts', 't', 'u'), conn('pcm', 'p', 'q')],
        }) as unknown as EngineState,
);

const click = (edgeId: string) => ({
    event: { preventDefault: vi.fn(), clientX: 10, clientY: 20 },
    edge: { id: edgeId },
});

function setup(withRefs = true) {
    const refs: EdgeMenuRefs = { openTagMenu: vi.fn(), setTagged: vi.fn() };
    const onClickOpen = vi.fn();
    const menu = useEdgeMenu(() => 'eng-1', engine, onClickOpen, withRefs ? refs : undefined);
    const actions = () => menu.edgeMenuItems.value.map((i) => i.action);
    return { menu, refs, onClickOpen, actions };
}

describe('useEdgeMenu with cross-reference tags', () => {
    it("a tag's stub opens the tag's dropdown, never the wire menu (so it can't be deleted)", () => {
        const { menu, refs, onClickOpen } = setup();
        menu.onEdgeClick(click('ref:out:a:out'));
        expect(refs.openTagMenu).toHaveBeenCalledWith('out:a:out', 10, 20);
        expect(menu.edgeContextMenu.value).toBeNull();
        expect(onClickOpen).not.toHaveBeenCalled();

        const right = click('ref:in:b:in');
        menu.onEdgeContextMenu(right);
        expect(right.event.preventDefault).toHaveBeenCalled();
        expect(refs.openTagMenu).toHaveBeenLastCalledWith('in:b:in', 10, 20);
        expect(menu.edgeContextMenu.value).toBeNull();
    });

    it('offers "Show as cross-reference" on 302M and MPEG-TS wires, before Delete', () => {
        const { menu, actions } = setup();
        menu.onEdgeClick(click('aud'));
        expect(actions()).toEqual(['editLabel', 'channelMap', 'showAsRef', '', 'delete']);
        menu.onEdgeClick(click('ts'));
        expect(actions()).toEqual(['editLabel', 'showAsRef', '', 'delete']);
        menu.onEdgeClick(click('pcm'));
        expect(actions()).not.toContain('showAsRef');
    });

    it('offers nothing new without cross-reference hooks', () => {
        const { menu, actions } = setup(false);
        menu.onEdgeClick(click('aud'));
        expect(actions()).not.toContain('showAsRef');
    });

    it('"Show as cross-reference" tags the wire and closes the menu', () => {
        const { menu, refs } = setup();
        menu.onEdgeClick(click('ts'));
        menu.onEdgeContextAction('showAsRef', vi.fn());
        expect(refs.setTagged).toHaveBeenCalledWith('ts', true);
        expect(menu.edgeContextMenu.value).toBeNull();
    });
});

describe('useContextMenu passes the cross-reference hooks to its edge menu', () => {
    beforeEach(() => setActivePinia(createPinia()));

    it('a stub click from the canvas menu opens the tag dropdown', () => {
        const refs: EdgeMenuRefs = { openTagMenu: vi.fn(), setTagged: vi.fn() };
        const menu = useContextMenu(
            () => 'eng-1',
            engine,
            computed(() => new Set<string>()),
            undefined,
            undefined,
            refs,
        );
        menu.onEdgeClick(click('ref:out:t:out'));
        expect(refs.openTagMenu).toHaveBeenCalledWith('out:t:out', 10, 20);
        expect(menu.edgeContextMenu.value).toBeNull();
    });

    it("a tag's right-click opens its dropdown, not a module menu", () => {
        const refs: EdgeMenuRefs = { openTagMenu: vi.fn(), setTagged: vi.fn() };
        const menu = useContextMenu(
            () => 'eng-1',
            engine,
            computed(() => new Set<string>()),
            undefined,
            undefined,
            refs,
        );
        const event = { preventDefault: vi.fn(), clientX: 7, clientY: 8 } as unknown as MouseEvent;
        menu.onNodeContextMenu({ event, node: { id: 'in:u:in', type: 'xref' } as never });
        expect(event.preventDefault).toHaveBeenCalled();
        expect(refs.openTagMenu).toHaveBeenCalledWith('in:u:in', 7, 8);
        expect(menu.contextMenu.value).toBeNull();
    });
});
