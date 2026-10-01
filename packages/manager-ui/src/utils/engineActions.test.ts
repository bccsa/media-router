import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const write = vi.fn();
const call = vi.fn();
vi.mock('@/stores/socket', () => ({ useSocketStore: () => ({ write, call }) }));

import { engineActions } from './engineActions';
import { useEngineStore } from '@/stores/engines';

describe('engineActions', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        write.mockReset().mockResolvedValue({ rejected: [] });
        call.mockReset().mockResolvedValue({});
    });

    it('setRunning is optimistic, then writes info/running', () => {
        const store = useEngineStore();
        store.ensureEngine('e1');
        engineActions.setRunning('e1', false);
        expect(store.engines.get('e1')?.running).toBe(false);
        expect(write).toHaveBeenCalledWith([{ op: 'replace', path: '/engines/e1/info/running', value: false }]);
    });

    it('actions are calls on the node, ids escaped', async () => {
        await engineActions.reset('e1');
        await engineActions.reboot('e1');
        await engineActions.restartModule('e1', 'a/b');
        expect(call.mock.calls).toEqual([
            ['/engines/e1', 'reset'],
            ['/engines/e1', 'reboot'],
            ['/engines/e1/modules/a~1b', 'restart'],
        ]);
    });

    it('a failed call is logged, not thrown', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        call.mockRejectedValue(new Error('Engine is offline'));
        await expect(engineActions.reboot('e1')).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
