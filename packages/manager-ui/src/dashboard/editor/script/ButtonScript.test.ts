/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ButtonScript from './ButtonScript.vue';
import StepList from './StepList.vue';
import MrModal from '@/components/common/MrModal.vue';
import type { DashboardWidget } from '@media-router/shared-types';
import type { DashboardSource } from '../../source';

const widget = { id: 'w1', type: 'button', x: 0, y: 0, w: 1, h: 1 } as unknown as DashboardWidget;

describe('ButtonScript', () => {
    it('opens the actions in a wide modal', async () => {
        const w = mount(ButtonScript, {
            props: { widget: { ...widget, script: { steps: [{ do: 'stop' }] } } as DashboardWidget, source: {} as DashboardSource },
            global: { stubs: { StepList: true } },
            attachTo: document.body,
        });
        expect(w.findComponent(MrModal).exists()).toBe(false);
        await w.findAll('button').find((b) => b.text().startsWith('Open editor'))!.trigger('click');
        expect(w.findComponent(MrModal).props('width')).toBe('max-w-3xl');
        expect(w.findAllComponents(StepList)).toHaveLength(2);
        w.unmount();
    });

    it('shows an older single action as the first step', () => {
        const w = mount(ButtonScript, {
            props: { widget: { ...widget, action: { kind: 'call', path: '/modules/m1', method: 'restart' } } as DashboardWidget, source: {} as DashboardSource },
            global: { stubs: { StepList: true } },
        });
        expect(w.findComponent(StepList).props('steps')).toEqual([{ do: 'call', path: '/modules/m1', method: 'restart' }]);
    });
});
