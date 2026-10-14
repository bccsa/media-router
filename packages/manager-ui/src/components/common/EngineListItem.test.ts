// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import EngineListItem from './EngineListItem.vue';
import type { EngineState } from '@/stores/engines';
import type { TimeSyncState } from '@media-router/shared-types';

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
            { path: '/routing/:engineId', component: { template: '<div />' } },
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

    // Regression: highlight is an exact engineId match, not a path substring —
    // '/routing/ivan-test-p4' must not light up the 'ivan-test' row.
    it('highlights only the exact active engine, not id-prefix siblings', async () => {
        const router = withRouter();
        await router.push('/routing/ivan-test-p4');
        await router.isReady();

        const sibling = mount(EngineListItem, {
            props: { engine: makeEngine({ engineId: 'ivan-test' }) },
            global: { plugins: [router] },
        });
        const active = mount(EngineListItem, {
            props: { engine: makeEngine({ engineId: 'ivan-test-p4' }) },
            global: { plugins: [router] },
        });

        expect(sibling.find('.engine-row').classes()).not.toContain('text-accent-fg');
        expect(active.find('.engine-row').classes()).toContain('text-accent-fg');
    });

    describe('time-sync clock indicator', () => {
        const base: TimeSyncState = {
            source: 'chrony',
            synced: true,
            traceable: true,
            taiOffsetS: 37,
            estErrorUs: 800,
            maxErrorUs: 9000,
            freqPpm: 3.5,
            waitingForSync: false,
            epochSeq: 1,
            epochLatchedAt: '2026-10-13T08:00:00.000Z',
            epochReason: 'start',
            sidecar: true,
        };
        function clockOf(timeSync: Partial<TimeSyncState>, features = ['house-clock']) {
            const wrapper = mount(EngineListItem, {
                props: {
                    engine: makeEngine({
                        features,
                        system: { cpu: 1, mem: 2, temp: 40, timeSync: { ...base, ...timeSync } },
                    }),
                },
                global: { plugins: [withRouter()] },
            });
            return wrapper.find('.engine-clock');
        }

        it('green when traceable', () => {
            const el = clockOf({});
            expect(el.classes()).toContain('text-ok');
            expect(el.attributes('aria-label')).toBe('Time traceable');
        });

        it('amber while waiting for sync, with the time left', () => {
            const el = clockOf({
                synced: false,
                traceable: false,
                waitingForSync: true,
                waitRemainingS: 21,
                epochSeq: 0,
            });
            expect(el.classes()).toContain('text-warning');
            expect(el.attributes('aria-label')).toBe('Waiting for time sync (21 s)');
        });

        it('amber when synced but untraceable (kernel TAI offset unset)', () => {
            const el = clockOf({ traceable: false, taiOffsetS: 0, epochReason: 'timeout' });
            expect(el.classes()).toContain('text-warning');
            expect(el.attributes('aria-label')).toMatch(/TAI offset unset/);
        });

        it('red when not synchronised after the start wait', () => {
            const el = clockOf({ synced: false, traceable: false, epochReason: 'timeout' });
            expect(el.classes()).toContain('text-error');
            expect(el.attributes('aria-label')).toBe('Time not synchronised');
        });

        it('the card tooltip carries source, error, TAI−UTC and the epoch, not only a colour', async () => {
            const router = withRouter();
            await router.push('/');
            await router.isReady();
            const wrapper = mount(EngineListItem, {
                props: {
                    engine: makeEngine({
                        features: ['house-clock'],
                        system: { cpu: 1, mem: 2, temp: 40, timeSync: base },
                    }),
                },
                global: { plugins: [router] },
            });
            const trigger = wrapper.find('[role="button"]');
            expect(trigger.find('.engine-clock').exists()).toBe(true);
            await trigger.trigger('mouseenter');
            const tip = document.body.querySelector('[role="tooltip"]')?.textContent ?? '';
            expect(tip).toContain('Time traceable');
            expect(tip).toContain('source chrony');
            expect(tip).toContain('error ±800 µs');
            expect(tip).toContain('TAI−UTC 37 s');
            expect(tip).toContain('epoch #1 (start) at 2026-10-13T08:00:00.000Z');
            // A click pins the tip and must not follow the row's link.
            await trigger.trigger('click');
            await flushPromises();
            expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();
            expect(router.currentRoute.value.fullPath).toBe('/');
            wrapper.unmount();
        });

        it('shows nothing for an older engine without the house-clock feature', () => {
            expect(clockOf({}, ['dashboards', 'interlocks']).exists()).toBe(false);
            const noStats = mount(EngineListItem, {
                props: { engine: makeEngine({ system: { cpu: 1, mem: 2, temp: 40 } }) },
                global: { plugins: [withRouter()] },
            });
            expect(noStats.find('.engine-clock').exists()).toBe(false);
        });
    });
});
