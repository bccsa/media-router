import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick } from 'vue';

// Mock the socket store before importing the composable
vi.mock('../stores/socket', () => {
    const emitFn = vi.fn();
    return {
        useSocketStore: () => ({ emit: emitFn }),
        __emitFn: emitFn,
    };
});

import { useEngineLifecycle } from './useEngineLifecycle';
import { useModuleStore } from '../stores/modules';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __emitFn: emitFn } = (await import('../stores/socket')) as any;

describe('useEngineLifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setActivePinia(createPinia());
        emitFn.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits the command and enters pending without flipping engineRunning', () => {
        const moduleStore = useModuleStore();
        moduleStore.engineRunning = true;
        const { enginePending, sendEngineCommand } = useEngineLifecycle();

        sendEngineCommand('stop');

        expect(emitFn).toHaveBeenCalledWith('stop');
        expect(enginePending.value).toBe(true);
        // Regression guard: the old optimistic flip made a lost press (WAN
        // socket churn) look applied — engineRunning must only follow the
        // engine's broadcast.
        expect(moduleStore.engineRunning).toBe(true);
    });

    it('clears pending when the engine confirms via engineRunning', async () => {
        const moduleStore = useModuleStore();
        moduleStore.engineRunning = true;
        const { enginePending, sendEngineCommand } = useEngineLifecycle();

        sendEngineCommand('stop');
        moduleStore.engineRunning = false; // engine broadcast arrives
        await nextTick();

        expect(enginePending.value).toBe(false);
    });

    it('clears pending after the timeout when no confirmation arrives', () => {
        const { enginePending, sendEngineCommand } = useEngineLifecycle(15000);

        sendEngineCommand('start');
        expect(enginePending.value).toBe(true);

        vi.advanceTimersByTime(14999);
        expect(enginePending.value).toBe(true);
        vi.advanceTimersByTime(1);
        expect(enginePending.value).toBe(false);
    });

    it('a second press restarts the pending timeout', () => {
        const { enginePending, sendEngineCommand } = useEngineLifecycle(15000);

        sendEngineCommand('start');
        vi.advanceTimersByTime(10000);
        sendEngineCommand('stop');
        vi.advanceTimersByTime(10000);

        // 20s after the first press but only 10s after the second — still pending
        expect(enginePending.value).toBe(true);
        vi.advanceTimersByTime(5000);
        expect(enginePending.value).toBe(false);
    });
});
