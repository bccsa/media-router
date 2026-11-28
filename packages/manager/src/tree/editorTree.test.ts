import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emptyEditorLayout } from '@media-router/shared-types';
import { setup } from './testing/managerTreeFixture.js';

const E = '/engines/e1/editor';
const page = (name: string, order = 0) => ({ name, order });

describe('manager tree: the editor branch (ADR-0030)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('serves the layout, defaults for a profile without one, inside the engine node too', () => {
        const { sock } = setup();
        expect(sock('a', [E]).snapshot).toEqual([
            { op: 'add', path: E, value: emptyEditorLayout() },
        ]);
        expect(sock('b', ['/engines/e1']).snapshot[0].value).toMatchObject({
            editor: emptyEditorLayout(),
        });
    });

    it('editor writes are stored, published and forwarded to the engine like other config ops', async () => {
        const { writes, track, stored, engineManager } = setup();
        const t = track('a', [E]);
        const res = await writes.handle(
            { socketId: 'x' },
            [
                {
                    op: 'add',
                    path: '/engines/e1/modules/m2',
                    value: { pluginId: 'audio-output', settings: {} },
                },
                { op: 'add', path: `${E}/pages/pg-a`, value: page('Main') },
                { op: 'add', path: `${E}/modulePages/m2`, value: 'pg-a' },
            ],
            1,
        );
        expect(res.rejected).toEqual([]);
        expect(stored().editor).toEqual({
            ...emptyEditorLayout(),
            pages: { 'pg-a': page('Main') },
            modulePages: { m2: 'pg-a' },
        });
        expect(t.sync().engines.e1.editor).toEqual(stored().editor);
        const [, topic, msg] = engineManager.sendToEngine.mock.calls[0];
        expect(topic).toBe('patch');
        expect(msg.ops.map((op: { op: string; path: string }) => `${op.op} ${op.path}`)).toEqual([
            'add /modules/m2',
            'add /editor',
            'add /editor/pages/pg-a',
            'add /editor/modulePages/m2',
        ]);
    });

    it('a duplicate ref add gets no second number and no rejection: its writer alone is sent the current value', async () => {
        const { writes, sock, ops, stored } = setup();
        const a = sock('a', [E]).s;
        const b = sock('b', ['/engines/e1/info']).s;
        const add = [{ op: 'add' as const, path: `${E}/refs/out:m1:out-0`, value: {} }];
        expect((await writes.handle({ socketId: 'a' }, add, 1)).rejected).toEqual([]);
        expect((await writes.handle({ socketId: 'b' }, add, 2)).rejected).toEqual([]);
        expect(stored().editor.refs).toEqual({ 'out:m1:out-0': { n: 1 } });
        expect(stored().editor.nextRef).toBe(2);
        expect(ops(b)).toEqual([
            { op: 'replace', path: `${E}/refs/out:m1:out-0`, value: { n: 1 }, w: 2 },
        ]);
        expect(ops(a).filter((op) => op.w === 2)).toEqual([]);
    });

    it('an invalid page name is rejected with its reason', async () => {
        const { writes, stored } = setup();
        const res = await writes.handle(
            { socketId: 'a' },
            [{ op: 'add', path: `${E}/pages/pg-a`, value: page('') }],
            1,
        );
        expect(res.rejected).toEqual([
            { index: 0, path: `${E}/pages/pg-a`, reason: 'A page needs a name' },
        ]);
        expect(stored().editor ?? emptyEditorLayout()).toMatchObject({ pages: {} });
    });

    it('only the whitelisted op shapes are writable', async () => {
        const { writes } = setup();
        const res = await writes.handle(
            { socketId: 'a' },
            [
                { op: 'replace', path: `${E}/nextRef`, value: 50 },
                { op: 'add', path: `${E}/pages/Page1`, value: page('A') },
                { op: 'replace', path: `${E}/pages/pg-a`, value: page('A') },
                { op: 'add', path: `${E}/refs/sideways:m1:p`, value: {} },
                { op: 'replace', path: `${E}/refs/out:m1:p/n`, value: 3 },
                { op: 'replace', path: `${E}/tagged/c1`, value: true },
                { op: 'remove', path: E },
                { op: 'add', path: `${E}/pages/pg-a/name/x`, value: 'A' },
            ],
            1,
        );
        expect(res.rejected.map((r) => [r.index, r.reason])).toEqual([
            [0, 'not writable'],
            [1, 'invalid page id'],
            [2, 'not writable'],
            [3, 'invalid ref key'],
            [4, 'not writable'],
            [5, 'not writable'],
            [6, 'not writable'],
            [7, 'not writable'],
        ]);
    });

    it('a module removed through the tree takes its page and refs with it, for every subscriber', async () => {
        const { writes, track, configStore, stored } = setup();
        configStore.updateProfileConfig('e1', 'default', {
            ...stored(),
            editor: {
                ...emptyEditorLayout(),
                pages: { 'pg-a': page('A') },
                modulePages: { m1: 'pg-a' },
                refs: { 'in:m1:in-0': { n: 1 } },
                nextRef: 2,
            },
        });
        const t = track('a', [E]);
        await writes.handle(
            { socketId: 'x' },
            [{ op: 'remove', path: '/engines/e1/modules/m1' }],
            1,
        );
        expect(stored().editor).toMatchObject({ modulePages: {}, refs: {}, nextRef: 2 });
        expect(t.sync().engines.e1.editor).toMatchObject({ modulePages: {}, refs: {} });
    });

    it('a vanished dynamic port prunes its refs: stored, published and sent to the engine', () => {
        const { engineManager, track, configStore, stored } = setup();
        configStore.updateProfileConfig('e1', 'default', {
            ...stored(),
            editor: {
                ...emptyEditorLayout(),
                refs: { 'in:m1:in-0': { n: 1 }, 'in:m1:in-1': { n: 2 } },
                nextRef: 3,
            },
        });
        const t = track('a', [E]);
        engineManager.emit('engineDynamicPorts', 'e1', {
            moduleId: 'm1',
            ports: [{ id: 'in-0', direction: 'input' }],
        });
        expect(stored().editor.refs).toEqual({ 'in:m1:in-0': { n: 1 } });
        expect(t.sync().engines.e1.editor.refs).toEqual({ 'in:m1:in-0': { n: 1 } });
        expect(engineManager.sendToEngine).toHaveBeenCalledWith(
            'e1',
            'patch',
            { ops: [{ op: 'remove', path: '/editor/refs/in:m1:in-1' }] },
            { guaranteeDelivery: true },
        );
    });

    it('an imported profile keeps every valid layout entry; activating it republishes the layout', async () => {
        const { writes, track, configStore } = setup();
        const editor = {
            pages: { 'pg-a': page('A'), Bad: page('B') },
            refs: { 'out:m1:out-0': { n: 4 } },
            nextRef: 'x',
        };
        await writes.handle(
            { socketId: 'x' },
            [
                {
                    op: 'add',
                    path: '/engines/e1/profiles/imported',
                    value: { config: { modules: {}, editor } },
                },
            ],
            1,
        );
        const expected = {
            ...emptyEditorLayout(),
            pages: { 'pg-a': page('A') },
            refs: { 'out:m1:out-0': { n: 4 } },
            nextRef: 5,
        };
        expect((configStore.getProfile('e1', 'imported') as any).editor).toEqual(expected);
        const t = track('a', [E]);
        await writes.handle(
            { socketId: 'x' },
            [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'imported' }],
            2,
        );
        expect(t.sync().engines.e1.editor).toEqual(expected);
    });
});
