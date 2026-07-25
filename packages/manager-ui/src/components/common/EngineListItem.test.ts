// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import EngineListItem from './EngineListItem.vue';
import type { EngineState } from '@/stores/engines';

function makeEngine(over: Partial<EngineState> = {}): EngineState {
    return {
        engineId: 'eng-1',
        name: 'Test Engine',
        online: true,
        running: false,
        activeProfile: null,
        modules: {},
        connections: [],
        interlocks: [],
        groupId: 'ungrouped',
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

describe('EngineListItem', () => {
    it('shows the engine name', () => {
        const wrapper = mount(EngineListItem, {
            props: { engine: makeEngine({ name: 'Studio Engine' }) },
            global: { plugins: [withRouter()] },
        });
        expect(wrapper.text()).toContain('Studio Engine');
    });

    it('renders system stats when online and present', () => {
        const wrapper = mount(EngineListItem, {
            props: {
                engine: makeEngine({
                    online: true,
                    system: { cpu: 33, mem: 50, temp: 60 },
                }),
            },
            global: { plugins: [withRouter()] },
        });
        expect(wrapper.text()).toContain('CPU 33%');
        expect(wrapper.text()).toContain('MEM 50%');
        expect(wrapper.text()).toContain('60°C');
    });

    it('shows the under-voltage warning icon when the flag is set', () => {
        const wrapper = mount(EngineListItem, {
            props: {
                engine: makeEngine({
                    online: true,
                    system: { cpu: 33, mem: 50, temp: 60, undervoltage: true },
                }),
            },
            global: { plugins: [withRouter()] },
        });
        expect(wrapper.find('[aria-label="Under-voltage detected"]').exists()).toBe(true);
    });

    it('has no under-voltage icon when the flag is unset', () => {
        const wrapper = mount(EngineListItem, {
            props: {
                engine: makeEngine({
                    online: true,
                    system: { cpu: 33, mem: 50, temp: 60 },
                }),
            },
            global: { plugins: [withRouter()] },
        });
        expect(wrapper.find('[aria-label="Under-voltage detected"]').exists()).toBe(false);
    });

    it('hides system stats when offline', () => {
        const wrapper = mount(EngineListItem, {
            props: {
                engine: makeEngine({
                    online: false,
                    system: { cpu: 33, mem: 50, temp: 60 },
                }),
            },
            global: { plugins: [withRouter()] },
        });
        expect(wrapper.text()).not.toContain('CPU');
    });

    it('emits contextmenu with engineId on right-click', async () => {
        const wrapper = mount(EngineListItem, {
            props: { engine: makeEngine({ engineId: 'studio' }) },
            global: { plugins: [withRouter()] },
        });
        await wrapper.find('.engine-row').trigger('contextmenu');
        const emitted = wrapper.emitted('contextmenu');
        expect(emitted).toBeDefined();
        // Second arg is the engineId.
        expect((emitted as unknown[][])![0][1]).toBe('studio');
    });
});
