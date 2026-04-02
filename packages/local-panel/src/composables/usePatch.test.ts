import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Mock the socket store before importing patch
vi.mock('@/stores/socket', () => {
    const emitFn = vi.fn();
    return {
        useSocketStore: () => ({ emit: emitFn }),
        __emitFn: emitFn,
    };
});

import { patch } from './usePatch';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __emitFn: emitFn } = await import('@/stores/socket') as any;

describe('usePatch', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        emitFn.mockClear();
    });

    describe('raw', () => {
        it('emits patch event with provided ops', () => {
            const ops = [
                { op: 'replace' as const, path: '/modules/mic-1/settings/volume', value: 80 },
            ];
            patch.raw(ops);
            expect(emitFn).toHaveBeenCalledWith('patch', { ops });
        });

        it('emits multiple ops in a single call', () => {
            const ops = [
                { op: 'replace' as const, path: '/modules/mic-1/settings/volume', value: 80 },
                { op: 'replace' as const, path: '/modules/mic-1/settings/mute', value: true },
            ];
            patch.raw(ops);
            expect(emitFn).toHaveBeenCalledOnce();
            expect(emitFn).toHaveBeenCalledWith('patch', { ops });
        });
    });

    describe('moduleSetting', () => {
        it('emits a replace op for the correct module setting path', () => {
            patch.moduleSetting('mic-1', 'volume', 75);
            expect(emitFn).toHaveBeenCalledWith('patch', {
                ops: [{ op: 'replace', path: '/modules/mic-1/settings/volume', value: 75 }],
            });
        });

        it('handles boolean values', () => {
            patch.moduleSetting('enc-1', 'audioEnabled', false);
            expect(emitFn).toHaveBeenCalledWith('patch', {
                ops: [{ op: 'replace', path: '/modules/enc-1/settings/audioEnabled', value: false }],
            });
        });

        it('handles string values', () => {
            patch.moduleSetting('mic-1', 'device', 'hw:0,0');
            expect(emitFn).toHaveBeenCalledWith('patch', {
                ops: [{ op: 'replace', path: '/modules/mic-1/settings/device', value: 'hw:0,0' }],
            });
        });

        it('handles null/undefined values', () => {
            patch.moduleSetting('mic-1', 'device', null);
            expect(emitFn).toHaveBeenCalledWith('patch', {
                ops: [{ op: 'replace', path: '/modules/mic-1/settings/device', value: null }],
            });
        });
    });
});
