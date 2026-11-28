// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, reactive, ref, type Ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { EngineState } from '@/stores/engines';

// The editor with a real Vue Flow and real page tabs; the store, socket, router and writes are faked.
const m = vi.hoisted(() => ({
    engine: null as unknown as Ref<EngineState>,
    route: null as unknown as { query: Record<string, unknown> },
    replace: vi.fn(),
    editor: vi.fn(),
}));
vi.mock('vue-router', () => ({
    useRoute: () => m.route,
    useRouter: () => ({ replace: (...a: unknown[]) => m.replace(...a) }),
}));
vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({ getEngine: () => m.engine.value, removeConnection: vi.fn() }),
}));
vi.mock('@/stores/socket', () => ({ useSocketStore: () => ({ subscribe: () => () => {} }) }));
vi.mock('@/composables/usePatch', () => ({
    patch: { editor: (...a: unknown[]) => m.editor(...a), raw: vi.fn() },
}));

import RoutingEditor from './RoutingEditor.vue';

const ModuleStub = defineComponent({
    props: { data: { type: Object, required: true } },
    setup: (p) => () => h('div', { class: 'mod' }, (p.data as { instanceId: string }).instanceId),
});

const mod = (id: string, x: number) => ({
    instanceId: id,
    displayName: id,
    enabled: true,
    running: false,
    settings: {},
    position: { x, y: 0 },
    ports: [],
});

function engine(): EngineState {
    return {
        engineId: 'eng-1',
        running: false,
        modules: { a: mod('a', 0), b: mod('b', 300), c: mod('c', 600) },
        connections: [],
        interlocks: [],
        editor: {
            pages: { 'pg-1': { name: 'Page 1', order: 0 }, 'pg-2': { name: 'Outputs', order: 1 } },
            modulePages: { a: 'pg-1', b: 'pg-1', c: 'pg-2' },
            refs: {},
            tagged: {},
            nextRef: 1,
        },
    } as unknown as EngineState;
}

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

let wrapper: VueWrapper | undefined;

async function setup() {
    wrapper = mount(RoutingEditor, {
        props: { engineId: 'eng-1' },
        attachTo: document.body,
        global: {
            stubs: { ModuleNode: ModuleStub, RoutingToolbar: true, RoutingOverlays: true },
        },
    });
    await flushPromises();
    return wrapper;
}

const shown = (w: VueWrapper) => w.findAll('.mod').map((n) => n.text());
const tabs = (w: VueWrapper) => w.findAll('[data-test="tab"]');

beforeEach(() => {
    setActivePinia(createPinia());
    m.engine = ref(engine());
    m.route = reactive({ query: {} });
    m.replace.mockReset();
    m.editor.mockReset();
    localStorage.clear();
    // jsdom has no layout: Vue Flow warns that its container has no size.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    wrapper?.unmount();
    wrapper = undefined;
});

describe('RoutingEditor pages', () => {
    it("shows the tabs and only the current page's modules", async () => {
        const w = await setup();
        expect(tabs(w).map((t) => t.find('span').text())).toEqual(['Page 1', 'Outputs']);
        expect(w.findAll('[data-test="count"]').map((c) => c.text())).toEqual(['2', '1']);
        expect(shown(w)).toEqual(['a', 'b']);
    });

    it('a tab click switches the canvas and the link', async () => {
        const w = await setup();
        await tabs(w)[1].trigger('click');
        await flushPromises();
        expect(shown(w)).toEqual(['c']);
        expect(m.replace).toHaveBeenCalledWith({ query: { page: 'pg-2' } });
        expect(tabs(w)[1].attributes('aria-selected')).toBe('true');
    });

    it('+ adds a page through the editor patch', async () => {
        const w = await setup();
        await w.find('[data-test="add"]').trigger('click');
        const [engineId, ops] = m.editor.mock.calls[0];
        expect(engineId).toBe('eng-1');
        expect(ops).toHaveLength(1);
        expect(ops[0]).toMatchObject({ op: 'add', value: { name: 'Page 3', order: 2 } });
        await nextTick();
        expect(m.replace).toHaveBeenCalled();
    });
});

describe('RoutingEditor cross-reference tags', () => {
    /** a (Page 1) feeds c (Outputs) over 302M: one tag on each page, both numbered. */
    function linkAcrossPages() {
        const e = m.engine.value;
        const port = (id: string, direction: string) => ({
            id,
            direction,
            streamType: 'audio/302m',
        });
        e.modules.a.ports = [port('out', 'output')] as never;
        e.modules.c.ports = [port('in', 'input')] as never;
        e.connections = [
            {
                id: 'a:out-c:in',
                sourceModuleId: 'a',
                sourcePortId: 'out',
                sinkModuleId: 'c',
                sinkPortId: 'in',
            },
        ] as never;
        e.editor!.refs = { 'out:a:out': { n: 4 }, 'in:c:in': { n: 5 } };
    }

    it("draws the page's tags as xref nodes; a tap opens that tag's dropdown", async () => {
        linkAcrossPages();
        const w = await setup();
        const tag = w.find('[role="button"][data-kind="out"]');
        expect(tag.attributes('aria-label')).toBe('Output reference #4 → Outputs');
        expect(w.find('[data-kind="in"]').exists()).toBe(false);

        await tag.trigger('click', { clientX: 12, clientY: 34 });
        await new Promise((r) => setTimeout(r, 300));
        const xref = w.findComponent({ name: 'RoutingOverlays' }).props('xref') as {
            tagMenu: unknown;
        };
        expect(xref.tagMenu).toEqual({ x: 12, y: 34, key: 'out:a:out' });

        await tabs(w)[1].trigger('click');
        await flushPromises();
        expect(w.find('[data-kind="in"]').attributes('aria-label')).toBe(
            'Input reference #5 ← Page 1',
        );
    });
});
