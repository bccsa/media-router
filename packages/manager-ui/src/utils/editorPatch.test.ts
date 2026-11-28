import { describe, it, expect } from 'vitest';
import { emptyEditorLayout } from '@media-router/shared-types';
import { editorRefusalText, waitsForEcho } from './editorPatch';

describe('waitsForEcho', () => {
    const editor = { ...emptyEditorLayout(), refs: { 'out:a:out': { n: 1 } }, nextRef: 2 };

    it("ref adds and field writes that would create a ref wait for the manager's number", () => {
        expect(waitsForEcho(editor, { op: 'add', path: '/editor/refs/in:b:in', value: {} })).toBe(
            true,
        );
        expect(
            waitsForEcho(editor, { op: 'replace', path: '/editor/refs/in:b:in/name', value: 'X' }),
        ).toBe(true);
        expect(
            waitsForEcho(undefined, {
                op: 'add',
                path: '/editor/refs/in:b:in/pos',
                value: { x: 1, y: 2 },
            }),
        ).toBe(true);
    });

    it('everything else is applied at once', () => {
        expect(
            waitsForEcho(editor, {
                op: 'replace',
                path: '/editor/refs/out:a:out/name',
                value: 'X',
            }),
        ).toBe(false);
        expect(waitsForEcho(editor, { op: 'remove', path: '/editor/refs/out:a:out' })).toBe(false);
        expect(waitsForEcho(editor, { op: 'remove', path: '/editor/refs/in:b:in/pos' })).toBe(
            false,
        );
        expect(
            waitsForEcho(editor, {
                op: 'add',
                path: '/editor/pages/pg-x',
                value: { name: 'X', order: 1 },
            }),
        ).toBe(false);
        expect(waitsForEcho(editor, { op: 'add', path: '/editor/tagged/c1', value: true })).toBe(
            false,
        );
        expect(
            waitsForEcho(editor, { op: 'replace', path: '/modules/refs/name', value: 'X' }),
        ).toBe(false);
    });
});

describe('editorRefusalText', () => {
    it('rewords the reasons a person can act on, without ids', () => {
        const page = '/engines/e1/editor/pages/pg-a/name';
        expect(editorRefusalText(page, 'Another page already has this name')).toBe(
            'Page name already in use',
        );
        expect(editorRefusalText(page, 'At most 40 characters')).toBe(
            'Page name too long (at most 40 characters)',
        );
        expect(
            editorRefusalText('/engines/e1/editor/refs/out:a:out/name', 'At most 40 characters'),
        ).toBe('Tag name too long (at most 40 characters)');
        expect(editorRefusalText(page, 'That page no longer exists')).toBe(
            'That page no longer exists',
        );
    });

    it('internal reasons become a plain "not saved"', () => {
        for (const reason of [
            'not writable',
            'invalid ref key',
            'duplicate ref number',
            'unknown engine',
        ])
            expect(editorRefusalText('/engines/e1/editor/refs/x', reason)).toBe(
                'Layout change not saved',
            );
    });
});
