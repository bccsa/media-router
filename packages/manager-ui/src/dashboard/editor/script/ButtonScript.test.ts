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

    it('takes a max run time in whole seconds, 1 to 3600, at Enter or on leaving the box (B-104)', async () => {
        const w = mount(ButtonScript, {
            props: { widget: { ...widget, script: { steps: [{ do: 'stop' }] } } as DashboardWidget, source: {} as DashboardSource },
            global: { stubs: { StepList: true } },
        });
        const box = w.get('input[type="number"]');
        // Cleared on the way to a new value: neither snapped back to 60 nor written.
        (box.element as HTMLInputElement).value = '';
        await box.trigger('input');
        expect((box.element as HTMLInputElement).value).toBe('');
        for (const [typed, reason] of [['0', 'Must be between 1 and 3600 s'], ['2.5', 'Enter a whole number'], ['', 'Enter a number']]) {
            await box.setValue(typed);
            expect(w.text()).toContain(reason);
        }
        expect(w.emitted('update')).toBeUndefined();
        await box.setValue('30');
        expect(w.emitted('update')).toEqual([[{ steps: [{ do: 'stop' }], timeoutS: 30 }]]);
    });

    it('shows an older single action as the first step', () => {
        const w = mount(ButtonScript, {
            props: { widget: { ...widget, action: { kind: 'call', path: '/modules/m1', method: 'restart' } } as DashboardWidget, source: {} as DashboardSource },
            global: { stubs: { StepList: true } },
        });
        expect(w.findComponent(StepList).props('steps')).toEqual([{ do: 'call', path: '/modules/m1', method: 'restart' }]);
    });
});
