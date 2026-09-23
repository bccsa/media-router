// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const request = vi.fn();
vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ request }),
}));
const show = vi.fn();
vi.mock('@/composables/useToast', () => ({
    useToast: () => ({ show }),
}));

import DgramListenersCard from './DgramListenersCard.vue';
import { useEngineStore } from '@/stores/engines';

async function mountCard(listeners: Array<{ port: number; bindAddress?: string }>) {
    request.mockReset();
    show.mockReset();
    request.mockImplementation(async (event: string, payload?: any) => {
        if (event === 'settings:get') return { dgramListeners: listeners };
        if (event === 'settings:set') return { dgramListeners: payload.dgramListeners };
        throw new Error(`unexpected ${event}`);
    });
    const wrapper = mount(DgramListenersCard);
    await flushPromises();
    return wrapper;
}

describe('DgramListenersCard', () => {
    beforeEach(() => setActivePinia(createPinia()));

    it('loads the saved listeners into one row each', async () => {
        const w = await mountCard([{ port: 3000 }, { port: 3002, bindAddress: '10.0.2.1' }]);
        expect(request).toHaveBeenCalledWith('settings:get');
        const rows = w.findAll('[data-test="listener-row"]');
        expect(rows).toHaveLength(2);
        expect((rows[0].find('input[type="number"]').element as HTMLInputElement).value).toBe(
            '3000',
        );
        expect((rows[1].find('input[type="text"]').element as HTMLInputElement).value).toBe(
            '10.0.2.1',
        );
    });

    it('cannot remove the last listener; Apply stays disabled until something changes', async () => {
        const w = await mountCard([{ port: 3000 }]);
        expect(w.find('[data-test="remove"]').attributes('disabled')).toBeDefined();
        expect(w.find('[data-test="apply"]').attributes('disabled')).toBeDefined();
    });

    it('Add picks the next free port, warns on removal of a saved one, and applies over RPC', async () => {
        const w = await mountCard([{ port: 3000 }, { port: 3001 }]);

        await w.find('[data-test="add"]').trigger('click');
        let rows = w.findAll('[data-test="listener-row"]');
        expect(rows).toHaveLength(3);
        expect((rows[2].find('input[type="number"]').element as HTMLInputElement).value).toBe(
            '3002',
        );

        await rows[1].find('[data-test="remove"]').trigger('click');
        expect(w.find('[data-test="remove-warning"]').text()).toContain('*:3001');

        await w.find('[data-test="apply"]').trigger('click');
        await flushPromises();
        expect(request).toHaveBeenCalledWith(
            'settings:set',
            { dgramListeners: [{ port: 3000 }, { port: 3002 }] },
            expect.objectContaining({ timeoutMs: expect.any(Number) }),
        );
        expect(show).toHaveBeenCalledWith(expect.stringContaining('applied'), 'info');
        // Saved snapshot caught up: no longer dirty, no warning.
        expect(w.find('[data-test="remove-warning"]').exists()).toBe(false);
        expect(w.find('[data-test="apply"]').attributes('disabled')).toBeDefined();
    });

    it('lists the online engines reaching the manager through each listener', async () => {
        const engines = useEngineStore();
        engines.addEngine({
            engine_id: 'eng-a',
            display_name: 'Studio A',
            online: true,
            modules: {},
            connections: [],
            paths: [
                { remote: '10.0.0.8:47112', listenerPort: 3000 },
                { remote: '10.0.0.8:42974', listenerPort: 3002 },
            ],
        });
        engines.addEngine({
            engine_id: 'eng-b',
            display_name: 'Gate B',
            online: true,
            modules: {},
            connections: [],
            paths: [{ remote: '10.0.0.9:5000', listenerPort: 3000 }],
        });
        const w = await mountCard([{ port: 3000 }, { port: 3002 }]);
        const notes = w.findAll('[data-test="engines-on"]');
        expect(notes).toHaveLength(2);
        expect(notes[0].text()).toContain('2');
        expect(notes[0].text()).toContain('Gate B, Studio A');
        expect(notes[1].text()).toContain('Studio A');
        expect(notes[1].text()).not.toContain('Gate B');
    });

    it('flags duplicate rows and blocks Apply', async () => {
        const w = await mountCard([{ port: 3000 }]);
        await w.find('[data-test="add"]').trigger('click');
        const rows = w.findAll('[data-test="listener-row"]');
        const port = rows[1].find('input[type="number"]');
        await port.setValue('3000');
        expect(w.find('[data-test="dup-warning"]').exists()).toBe(true);
        expect(w.find('[data-test="apply"]').attributes('disabled')).toBeDefined();
    });

    it('shows the server error when the rebind is refused', async () => {
        const w = await mountCard([{ port: 3000 }]);
        request.mockImplementation(async (event: string) => {
            if (event === 'settings:set') throw new Error('Could not bind listeners: EADDRINUSE');
            return { dgramListeners: [{ port: 3000 }] };
        });
        await w.find('[data-test="add"]').trigger('click');
        await w.find('[data-test="apply"]').trigger('click');
        await flushPromises();
        expect(show).toHaveBeenCalledWith('Could not bind listeners: EADDRINUSE');
        // Rows keep the operator's edit so they can fix and retry.
        expect(w.findAll('[data-test="listener-row"]')).toHaveLength(2);
    });
});
