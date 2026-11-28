import { describe, it, expect } from 'vitest';
import { emptyEditorLayout } from '@media-router/shared-types';
import type { EngineState } from './engines';
import { editorForPatch, withoutBranches } from './engineGraph';

describe('editorForPatch', () => {
    it('copies the layout when an op writes it, else keeps the same object', () => {
        const editor = { ...emptyEditorLayout(), tagged: { c1: true as const } };
        const copy = editorForPatch(editor, [{ op: 'remove', path: '/editor/tagged/c1' }]);
        expect(copy).toEqual(editor);
        expect(copy).not.toBe(editor);
        expect(copy!.tagged).not.toBe(editor.tagged);

        const ops = [{ op: 'replace' as const, path: '/modules/m1/position', value: {} }];
        expect(editorForPatch(editor, ops)).toBe(editor);
        expect(editorForPatch(undefined, ops)).toBeUndefined();
    });

    it('starts from an empty layout when there is none yet', () => {
        const ops = [{ op: 'add' as const, path: '/editor/pages/pg-a', value: {} }];
        expect(editorForPatch(undefined, ops)).toEqual(emptyEditorLayout());
    });
});

describe('withoutBranches', () => {
    it('empties only the listed branches', () => {
        const engine = {
            engineId: 'e1',
            modules: { m1: {} },
            connections: [{ id: 'c1' }],
            interlocks: [{ id: 'i1' }],
            profiles: { p: { name: 'p', active: true } },
            editor: emptyEditorLayout(),
        } as unknown as EngineState;
        const next = withoutBranches(engine, ['modules', 'editor']);
        expect(next).toMatchObject({ modules: {}, connections: [{ id: 'c1' }], editor: undefined });
        expect(next.interlocks).toBe(engine.interlocks);
        expect(next.profiles).toBe(engine.profiles);
        expect(engine.modules).toEqual({ m1: {} });
        expect(withoutBranches(engine, ['connections', 'interlocks', 'profiles'])).toMatchObject({
            connections: [],
            interlocks: [],
            profiles: undefined,
        });
    });
});
