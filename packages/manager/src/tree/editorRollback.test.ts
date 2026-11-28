import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emptyEditorLayout } from '@media-router/shared-types';
import { setup } from './testing/managerTreeFixture.js';

const E = '/engines/e1/editor';
const page = (name: string, order = 0) => ({ name, order });

describe('manager tree: rollback of the editor layout (ADR-0030)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("rollback restores the version's layout and never hands a ref number out twice", async () => {
        const { writes, calls, track, stored, engineManager } = setup();
        const t = track('a', [E]);
        await writes.handle(
            { socketId: 'x' },
            [{ op: 'add', path: `${E}/pages/pg-a`, value: page('One') }],
            1,
        );
        vi.advanceTimersByTime(11 * 60 * 1000); // history keeps one version per 10 min
        await writes.handle(
            { socketId: 'x' },
            [
                { op: 'replace', path: `${E}/pages/pg-a/name`, value: 'Two' },
                { op: 'add', path: `${E}/refs/out:m1:out-0`, value: {} },
            ],
            2,
        );
        const versions = calls.handle(
            { socketId: 'x' },
            '/engines/e1/profiles/default',
            'history',
            {},
        ) as Array<{ id: number; config: string }>;
        const one = versions.find(
            (v) => JSON.parse(v.config).editor?.pages['pg-a'].name === 'One',
        )!;
        engineManager.sendToEngine.mockClear();
        calls.handle({ socketId: 'x' }, '/engines/e1/profiles/default', 'rollback', {
            versionId: one.id,
        });
        const restored = { ...emptyEditorLayout(), pages: { 'pg-a': page('One') }, nextRef: 2 };
        expect(stored().editor).toEqual(restored);
        expect(t.sync().engines.e1.editor).toEqual(restored);
        expect(engineManager.sendToEngine.mock.calls).toEqual([
            [
                'e1',
                'patch',
                { ops: [{ op: 'replace', path: '/editor', value: restored }] },
                { guaranteeDelivery: true },
            ],
        ]);
    });

    it('rollback restores a removed module with its page, the layout landing after the graph', async () => {
        const { writes, calls, stored, engineManager } = setup();
        await writes.handle(
            { socketId: 'x' },
            [
                {
                    op: 'add',
                    path: '/engines/e1/modules/m2',
                    value: { pluginId: 'audio-output', displayName: 'Two', settings: {} },
                },
                { op: 'add', path: `${E}/pages/pg-a`, value: page('One') },
                { op: 'add', path: `${E}/pages/pg-b`, value: page('Two', 1) },
                { op: 'add', path: `${E}/modulePages/m1`, value: 'pg-a' },
                { op: 'add', path: `${E}/modulePages/m2`, value: 'pg-b' },
            ],
            1,
        );
        vi.advanceTimersByTime(11 * 60 * 1000);
        await writes.handle(
            { socketId: 'x' },
            [{ op: 'remove', path: '/engines/e1/modules/m2' }],
            2,
        );
        expect(stored().editor.modulePages).toEqual({ m1: 'pg-a' });

        const versions = calls.handle(
            { socketId: 'x' },
            '/engines/e1/profiles/default',
            'history',
            {},
        ) as Array<{ id: number; config: string }>;
        const withM2 = versions.find((v) => 'm2' in JSON.parse(v.config).modules)!;
        engineManager.sendToEngine.mockClear();
        calls.handle({ socketId: 'x' }, '/engines/e1/profiles/default', 'rollback', {
            versionId: withM2.id,
        });
        expect(Object.keys(stored().modules)).toEqual(['m1', 'm2']);
        expect(stored().editor.modulePages).toEqual({ m1: 'pg-a', m2: 'pg-b' });
        const sent = engineManager.sendToEngine.mock.calls.flatMap(([, , msg]) =>
            (msg as { ops: Array<{ op: string; path: string }> }).ops.map(
                (o) => `${o.op} ${o.path}`,
            ),
        );
        expect(sent.indexOf('add /modules/m2')).toBeGreaterThanOrEqual(0);
        expect(sent.indexOf('add /modules/m2')).toBeLessThan(sent.indexOf('replace /editor'));
    });

    it('rollback of an inactive profile stores the layout with nextRef kept', () => {
        const { configStore, calls } = setup();
        const spare = (nextRef: number) => ({
            modules: {},
            connections: [],
            interlocks: [],
            editor: { ...emptyEditorLayout(), nextRef },
        });
        configStore.createProfile('e1', 'spare', {});
        configStore.updateProfileConfig('e1', 'spare', spare(2));
        vi.advanceTimersByTime(11 * 60 * 1000);
        configStore.updateProfileConfig('e1', 'spare', spare(6));
        const first = configStore
            .getVersionHistory('e1', 'spare')
            .find((v) => JSON.parse(v.config).editor.nextRef === 2)!;
        calls.handle({ socketId: 'x' }, '/engines/e1/profiles/spare', 'rollback', {
            versionId: first.id,
        });
        expect((configStore.getProfile('e1', 'spare') as any).editor.nextRef).toBe(6);
    });
});
