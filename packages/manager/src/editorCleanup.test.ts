import { describe, it, expect } from 'vitest';
import { emptyEditorLayout } from '@media-router/shared-types';
import { engineSenderId } from './PatchRouter.js';
import { idsOf, pruneRefsForPorts, restoredEditor } from './editorCleanup.js';
import { harness, profile } from './testing/editorHarness.js';

/** m1 and m2 placed, a ref on each end of c1, c1 drawn as tags. */
const placed = () => ({
    ...emptyEditorLayout(),
    pages: { 'pg-a': { name: 'A', order: 0 } },
    modulePages: { m1: 'pg-a', m2: 'pg-a' },
    refs: { 'out:m1:out-0': { n: 1 }, 'out:m1:out-1': { n: 2 }, 'in:m2:in-0': { n: 3 } },
    tagged: { c1: true },
    nextRef: 4,
});

describe('EditorBatch: cleanup after removals', () => {
    it("a module remove drops its page, its refs and its connections' tagged entries", () => {
        const h = harness(profile(placed()));
        h.write([{ op: 'remove', path: '/modules/m1' }]);
        expect(h.editor().modulePages).toEqual({ m2: 'pg-a' });
        expect(h.editor().refs).toEqual({ 'in:m2:in-0': { n: 3 } });
        expect(h.editor().tagged).toEqual({});
        expect(h.editor().nextRef).toBe(4);
        expect(h.cascades()).toEqual([
            { op: 'remove', path: '/connections/c1' },
            { op: 'remove', path: '/editor/tagged/c1' },
            { op: 'remove', path: '/editor/modulePages/m1' },
            { op: 'remove', path: '/editor/refs/out:m1:out-0' },
            { op: 'remove', path: '/editor/refs/out:m1:out-1' },
        ]);
    });

    it('the cleanup goes to the engine with the batch, after the op it follows', () => {
        const h = harness(profile(placed()));
        h.write([{ op: 'remove', path: '/connections/c1' }]);
        expect(h.sent).toEqual([
            [
                { op: 'remove', path: '/connections/0' },
                { op: 'remove', path: '/editor/tagged/c1' },
            ],
        ]);
    });

    it('an engine that removed a module itself is sent the cleanup it did not apply', () => {
        const h = harness(profile(placed()));
        h.write([{ op: 'remove', path: '/modules/m2' }], engineSenderId('e1'));
        expect(h.sent[0]).toEqual(
            expect.arrayContaining([
                { op: 'remove', path: '/editor/modulePages/m2' },
                { op: 'remove', path: '/editor/refs/in:m2:in-0' },
                { op: 'remove', path: '/editor/tagged/c1' },
            ]),
        );
        expect(h.sent[0]).not.toContainEqual({ op: 'remove', path: '/modules/m2' });
    });

    it('two connection removes in one batch each untag their own connection', () => {
        const config = profile({ ...placed(), tagged: { c1: true, c2: true } });
        (config.connections as unknown[]).push({
            id: 'c2',
            sourceModuleId: 'm1',
            sourcePortId: 'out-1',
            sinkModuleId: 'm2',
            sinkPortId: 'in-0',
        });
        (config.connections as unknown[]).push({
            id: 'c3',
            sourceModuleId: 'm2',
            sourcePortId: 'out-0',
            sinkModuleId: 'm1',
            sinkPortId: 'in-0',
        });
        const h = harness(config);
        h.write([
            { op: 'remove', path: '/connections/c1' },
            { op: 'remove', path: '/connections/c3' },
        ]);
        expect(h.editor().tagged).toEqual({ c2: true });
    });

    it('a whole connections write untags the connections it leaves out', () => {
        const h = harness(profile(placed()));
        h.write([{ op: 'replace', path: '/connections', value: [] }]);
        expect(h.editor().tagged).toEqual({});
    });

    it('a ports replace drops the refs of ports that are gone', () => {
        const h = harness(profile(placed()));
        h.write([
            {
                op: 'replace',
                path: '/modules/m1/ports',
                value: [{ id: 'out-0', direction: 'output' }],
            },
        ]);
        expect(h.editor().refs).toEqual({ 'out:m1:out-0': { n: 1 }, 'in:m2:in-0': { n: 3 } });
    });

    it('the pairCount port cascade drops the refs of the ports it regenerates away', () => {
        const h = harness(profile(placed()), { manifestPorts: [] });
        h.write([{ op: 'replace', path: '/modules/m1/settings/pairCount', value: 1 }]);
        expect(h.cascades().map((op) => op.path)).toEqual([
            '/modules/m1/ports',
            '/editor/refs/out:m1:out-1',
        ]);
        expect(Object.keys(h.editor().refs)).toEqual(['out:m1:out-0', 'in:m2:in-0']);
    });

    it('a profile without a layout gets no cleanup and no seed', () => {
        const h = harness(profile());
        h.write([{ op: 'remove', path: '/modules/m1' }]);
        expect(h.config.editor).toBeUndefined();
        expect(h.cascades()).toEqual([{ op: 'remove', path: '/connections/c1' }]);
    });
});

describe('editor helpers', () => {
    it('pruneRefsForPorts removes only that module’s refs on ports not kept; tolerates any stored shape', () => {
        expect(pruneRefsForPorts(placed(), 'm1', ['out-1'])).toEqual([
            { op: 'remove', path: '/editor/refs/out:m1:out-0' },
        ]);
        expect(pruneRefsForPorts(placed(), 'm9', [])).toEqual([]);
        expect(pruneRefsForPorts(undefined, 'm1', [])).toEqual([]);
        expect(pruneRefsForPorts({ refs: [1] }, 'm1', [])).toEqual([]);
    });

    it('idsOf reads string ids, skipping anything else', () => {
        expect(idsOf([{ id: 'a' }, { id: 2 }, null, { name: 'x' }, { id: 'b' }])).toEqual([
            'a',
            'b',
        ]);
        expect(idsOf('nope')).toEqual([]);
    });

    it("restoredEditor: the version's layout or defaults, nextRef never back", () => {
        expect(restoredEditor({ nextRef: 7 }, profile())).toEqual({
            ...emptyEditorLayout(),
            nextRef: 7,
        });
        expect(restoredEditor({ nextRef: 2 }, profile(placed()))).toEqual(placed());
        expect(restoredEditor({ nextRef: 9 }, profile(placed())).nextRef).toBe(9);
    });

    it('restoredEditor drops entries for modules and connections the version lacks', () => {
        const version = { ...profile(placed()), connections: [] };
        delete (version.modules as Record<string, unknown>).m2;
        expect(restoredEditor({ nextRef: 2 }, version)).toEqual({
            ...placed(),
            modulePages: { m1: 'pg-a' },
            refs: { 'out:m1:out-0': { n: 1 }, 'out:m1:out-1': { n: 2 } },
            tagged: {},
        });
    });
});
