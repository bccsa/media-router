import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useToast } from './useToast';

describe('useToast', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        const { toasts, dismiss } = useToast();
        for (const t of [...toasts.value]) dismiss(t.id);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows a toast and auto-dismisses it after the TTL', () => {
        const { toasts, show } = useToast();
        show('Only one muxed/mpegts source can feed an input');
        expect(toasts.value).toHaveLength(1);
        expect(toasts.value[0].kind).toBe('error');
        vi.advanceTimersByTime(4000);
        expect(toasts.value).toHaveLength(0);
    });

    it('collapses duplicate messages instead of stacking them', () => {
        const { toasts, show } = useToast();
        show('same');
        show('same');
        expect(toasts.value).toHaveLength(1);
    });

    it('stacks distinct messages and dismisses on demand', () => {
        const { toasts, show, dismiss } = useToast();
        show('a');
        show('b', 'info');
        expect(toasts.value).toHaveLength(2);
        dismiss(toasts.value[0].id);
        expect(toasts.value).toHaveLength(1);
        expect(toasts.value[0].message).toBe('b');
    });
});
