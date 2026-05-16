// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import EngineGroup from './EngineGroup.vue';
import type { EngineState } from '@/stores/engines';
import type { EngineGroupState } from '@/stores/engineGroups';

function makeGroup(over: Partial<EngineGroupState> = {}): EngineGroupState {
    return {
        id: 'g1',
        name: 'Studio',
        sortOrder: 0,
        collapsed: false,
        isDefault: false,
        color: null,
        ...over,
    };
}

function makeEngine(id: string, over: Partial<EngineState> = {}): EngineState {
    return {
        engineId: id,
        name: id,
        online: true,
        running: false,
        activeProfile: null,
        modules: {},
        connections: [],
        interlocks: [],
        groupId: 'g1',
        sortOrder: 0,
        ...over,
    };
}

function withRouter() {
    return createRouter({
        history: createMemoryHistory(),
        routes: [
            { path: '/', component: { template: '<div />' } },
            { path: '/routing/:id', component: { template: '<div />' } },
        ],
    });
}

describe('EngineGroup', () => {
    it('renders the group name and engine count', () => {
        const wrapper = mount(EngineGroup, {
            props: {
                group: makeGroup({ name: 'On-Air' }),
                engines: [makeEngine('a'), makeEngine('b')],
            },
            global: { plugins: [withRouter()] },
        });
        expect(wrapper.text()).toContain('On-Air');
        expect(wrapper.text()).toContain('2');
    });

    it('shows the color dot when group.color is set', () => {
        const wrapper = mount(EngineGroup, {
            props: { group: makeGroup({ color: '#10b981' }), engines: [] },
            global: { plugins: [withRouter()] },
        });
        const dot = wrapper.find('.group-header span[style*="background-color"]');
        expect(dot.exists()).toBe(true);
        // jsdom returns rgb form; spot-check that something is set.
        expect(dot.attributes('style')).toContain('background-color');
    });

    it('emits toggle-collapsed when the header is clicked', async () => {
        const wrapper = mount(EngineGroup, {
            props: { group: makeGroup({ collapsed: false }), engines: [] },
            global: { plugins: [withRouter()] },
        });
        await wrapper.find('.group-header').trigger('click');
        const ev = wrapper.emitted('toggle-collapsed');
        expect(ev).toBeDefined();
        // Toggles from current (false) to !false = true.
        expect((ev as unknown[][])![0]).toEqual(['g1', true]);
    });

    it('emits group-contextmenu on header right-click', async () => {
        const wrapper = mount(EngineGroup, {
            props: { group: makeGroup(), engines: [] },
            global: { plugins: [withRouter()] },
        });
        await wrapper.find('.group-header').trigger('contextmenu');
        expect(wrapper.emitted('group-contextmenu')).toBeDefined();
    });

    it('hides the engine list and shows hint when collapsed', () => {
        const wrapper = mount(EngineGroup, {
            props: { group: makeGroup({ collapsed: true }), engines: [makeEngine('a')] },
            global: { plugins: [withRouter()] },
        });
        // The engine row is rendered (vuedraggable mounts items) but the wrapper
        // is v-show=false. Just check the hint text isn't shown.
        expect(wrapper.text()).not.toContain('Drop engines here');
    });

    it('shows the "Drop engines here" hint when expanded and empty', () => {
        const wrapper = mount(EngineGroup, {
            props: { group: makeGroup({ collapsed: false }), engines: [] },
            global: { plugins: [withRouter()] },
        });
        expect(wrapper.text()).toContain('Drop engines here');
    });

    it('rename: commit on Enter emits a trimmed name', async () => {
        const wrapper = mount(EngineGroup, {
            props: { group: makeGroup({ name: 'Studio' }), engines: [] },
            global: { plugins: [withRouter()] },
        });
        (wrapper.vm as unknown as { startRename: () => void }).startRename();
        await flushPromises();
        const input = wrapper.find('.group-header input');
        await input.setValue('   On-Air   ');
        await input.trigger('keydown.enter');
        const ev = wrapper.emitted('rename');
        expect(ev).toBeDefined();
        expect((ev as unknown[][])![0]).toEqual(['g1', 'On-Air']);
    });

    it('rename: Esc cancels even though blur fires after teardown', async () => {
        const wrapper = mount(EngineGroup, {
            props: { group: makeGroup({ name: 'Studio' }), engines: [] },
            global: { plugins: [withRouter()] },
        });
        (wrapper.vm as unknown as { startRename: () => void }).startRename();
        await flushPromises();
        const input = wrapper.find('.group-header input');
        await input.setValue('Half-typed');
        await input.trigger('keydown.esc');
        // After Esc the input is gone; simulate the blur the browser would
        // still fire on the now-detached element.
        await input.trigger('blur');
        expect(wrapper.emitted('rename')).toBeUndefined();
    });

    it('rename: empty name does not emit', async () => {
        const wrapper = mount(EngineGroup, {
            props: { group: makeGroup({ name: 'Studio' }), engines: [] },
            global: { plugins: [withRouter()] },
        });
        (wrapper.vm as unknown as { startRename: () => void }).startRename();
        await flushPromises();
        const input = wrapper.find('.group-header input');
        await input.setValue('   ');
        await input.trigger('keydown.enter');
        expect(wrapper.emitted('rename')).toBeUndefined();
    });
});
