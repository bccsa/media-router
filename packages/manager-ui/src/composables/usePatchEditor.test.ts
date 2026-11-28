/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { emptyEditorLayout } from '@media-router/shared-types';

type Rejection = { index: number; path: string; reason: string };
const mockApplyEnginePatch = vi.fn();
const mockWrite = vi.fn(
    async (..._ops: unknown[]): Promise<{ rejected: Rejection[] }> => ({ rejected: [] }),
);
const mockGetEngine = vi.fn();

vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({ applyEnginePatch: mockApplyEnginePatch, getEngine: mockGetEngine }),
}));
vi.mock('@/stores/socket', () => ({ useSocketStore: () => ({ write: mockWrite }) }));

import { patch } from './usePatch';
import { useToast } from './useToast';

const shown = () => useToast().toasts.value.map((t) => t.message);
const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
};
const page = {
    op: 'add' as const,
    path: '/editor/pages/pg-b',
    value: { name: 'Page 2', order: 1 },
};
const refAdd = { op: 'add' as const, path: '/editor/refs/in:b:in', value: {} };

describe('patch.editor', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        for (const t of useToast().toasts.value) useToast().dismiss(t.id);
        mockApplyEnginePatch.mockClear();
        mockWrite.mockReset();
        mockWrite.mockResolvedValue({ rejected: [] });
        mockGetEngine.mockReturnValue({
            modules: {},
            editor: { ...emptyEditorLayout(), refs: { 'out:a:out': { n: 1 } }, nextRef: 2 },
        });
    });

    it('applies page ops at once and writes every op under the engine', () => {
        patch.editor('e1', [page]);
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('e1', [page]);
        expect(mockWrite).toHaveBeenCalledWith([
            { ...page, path: '/engines/e1/editor/pages/pg-b' },
        ]);
    });

    it('a ref add waits for the echo with its number; the rest of the batch is applied', () => {
        const rename = {
            op: 'replace' as const,
            path: '/editor/refs/out:a:out/name',
            value: 'Feed',
        };
        const newName = { op: 'replace' as const, path: '/editor/refs/in:c:in/name', value: 'New' };
        patch.editor('e1', [refAdd, rename, newName]);
        expect(mockApplyEnginePatch).toHaveBeenCalledWith('e1', [rename]);
        expect(mockWrite.mock.calls[0][0]).toHaveLength(3);
    });

    it('a batch of only ref adds touches nothing locally', () => {
        patch.editor('e1', [refAdd]);
        expect(mockApplyEnginePatch).not.toHaveBeenCalled();
        expect(mockWrite).toHaveBeenCalledOnce();
    });

    it('a refused batch shows one readable toast, without ids', async () => {
        mockWrite.mockResolvedValue({
            rejected: [0, 1, 2].map((index) => ({
                index,
                path: `/engines/e1/editor/modulePages/m${index}`,
                reason: 'Another page already has this name',
            })),
        });
        patch.editor('e1', [page]);
        await settle();
        expect(shown()).toEqual(['Page name already in use']);
    });

    it('an internal reason reads "Layout change not saved"; module refusals keep their own text', async () => {
        mockWrite.mockResolvedValue({
            rejected: [
                { index: 0, path: '/engines/e1/editor/refs/bad', reason: 'invalid ref key' },
                { index: 1, path: '/engines/e1/modules/m1/position', reason: 'unknown module' },
            ],
        });
        patch.editor('e1', [refAdd]);
        await settle();
        expect(shown()).toEqual([
            'Layout change not saved',
            'position (m1) not saved: unknown module',
        ]);
    });
});
