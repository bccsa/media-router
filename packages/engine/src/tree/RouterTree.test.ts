import { describe, it, expect, vi, afterEach } from 'vitest';
import { TreeCallError } from '@media-router/topic-tree';
import { fakeSocket } from '@media-router/topic-tree/dist/testing.js';
import { applyJsonPatch, type PatchOp } from '@media-router/shared-types';
import { RouterView, type RouterViewDeps } from './RouterView.js';
import { RouterTree } from './RouterTree.js';
import { routerCall, routerWrites, type RouterActions } from './routerWrites.js';

const schema = {
    properties: {
        volume: { type: 'number', minimum: 0, maximum: 150, 'x-live': true },
        channels: { type: 'integer', minimum: 1, maximum: 8 },
        gain: { type: 'number', 'x-maxFrom': 'ceiling' },
        ceiling: { type: 'number' },
        detected: { type: 'string', 'x-readOnly': true },
    },
};

function setup() {
    const config: Record<string, any> = {
        modules: {
            m1: { pluginId: 'mixer', displayName: 'Mix', enabled: true, settings: { volume: 100, ceiling: 10 } },
        },
        connections: [{ id: 'c1', sourceModuleId: 'm1' }],
        interlocks: [],
    };
    const info = { name: 'default', running: true };
    const deps: RouterViewDeps = {
        config: () => config,
        manifest: (id) => (id === 'mixer' ? { color: '#f00', configSchema: { properties: {} }, ports: [{ id: 'out' }] } : undefined),
        schema: (id) => (id === 'mixer' ? schema : undefined),
        state: (id) => (id === 'm1' ? ({ running: true, health: 'ok', vuData: [-3] } as any) : undefined),
        info: () => info,
    };
    const actions: RouterActions = {
        // Applies to the config, as the engine's patch router does.
        patch: vi.fn((_sender: string, ops: PatchOp[]) => applyJsonPatch(config, ops)),
        setRunning: vi.fn(),
        restartModule: vi.fn(),
        reboot: vi.fn(),
        managerConnected: vi.fn().mockReturnValue(true),
    };
    const view = new RouterView(deps);
    const tree = new RouterTree(view, actions, () => 'b1');
    const published = vi.spyOn(tree.bus, 'publish');
    const write = (ops: PatchOp[]) => routerWrites(tree, actions, 's1', ops, 7);
    return { config, info, view, tree, actions, published, write };
}

describe('RouterView', () => {
    it('builds a module from stored config, manifest, host schema and lean runtime', () => {
        const { view } = setup();
        view.vu.m1 = [-6];
        expect(view.module('m1')).toEqual({
            pluginId: 'mixer',
            displayName: 'Mix',
            enabled: true,
            settings: { volume: 100, ceiling: 10 },
            instanceId: 'm1',
            color: '#f00',
            configSchema: schema,
            ports: [{ id: 'out' }],
            // Manager overlay defaults (PluginRegistry.overlayManifest).
            interlock: false,
            resizable: false,
            running: true,
            health: 'ok',
            vu: [-6],
        });
    });

    it('serves branches, element ids and deep values', () => {
        const { view } = setup();
        expect(view.keys([])).toEqual(['info', 'system', 'devices', 'logs', 'modules', 'connections', 'interlocks']);
        expect(view.keys(['connections'])).toEqual(['c1']);
        expect(view.get(['modules', 'm1', 'settings', 'volume'])).toBe(100);
        expect(view.get(['connections', 'c1', 'sourceModuleId'])).toBe('m1');
        expect(view.get(['modules', 'nope'])).toBeUndefined();
    });

    it('keeps only the newest log lines', () => {
        const { view } = setup();
        view.appendLogs(Array.from({ length: 1005 }, (_, i) => i));
        expect(view.logs).toHaveLength(1000);
        expect(view.logs[0]).toBe(5);
    });
});

describe('RouterTree publishing', () => {
    it('config: module ops as-is, a module add as the full node, connection ops as the whole array', () => {
        const { tree, published } = setup();
        tree.config([
            { op: 'replace', path: '/modules/m1/settings/volume', value: 90 },
            { op: 'add', path: '/modules/m1', value: { pluginId: 'mixer' } },
            { op: 'remove', path: '/connections/0' },
        ]);
        const ops = published.mock.calls[0][0];
        expect(ops[0]).toEqual({ op: 'replace', path: '/modules/m1/settings/volume', value: 90 });
        expect(ops[1].value).toMatchObject({ instanceId: 'm1', color: '#f00' });
        expect(ops[2]).toEqual({ op: 'replace', path: '/connections', value: [{ id: 'c1', sourceModuleId: 'm1' }] });
    });

    it('config: a root replace republishes the graph', () => {
        const { tree, published } = setup();
        tree.config([{ op: 'replace', path: '', value: {} }]);
        expect(published.mock.calls[0][0].map((o) => o.path)).toEqual(['/modules', '/connections', '/interlocks']);
    });

    it('info and system publish only what changed', () => {
        const { tree, info, published } = setup();
        tree.info();
        info.running = false;
        tree.info();
        expect(published).toHaveBeenLastCalledWith([{ op: 'replace', path: '/info/running', value: false }]);
        tree.system({ cpu: 5, mem: 1 });
        tree.system({ cpu: 6, mem: 1 });
        expect(published).toHaveBeenLastCalledWith([{ op: 'replace', path: '/system/cpu', value: 6 }]);
    });

    it('devices: an unchanged list is not republished', () => {
        const { tree, published } = setup();
        tree.devices('audio-sink', [{ name: 'hw:0' }]);
        tree.devices('audio-sink', [{ name: 'hw:0' }]);
        expect(published).toHaveBeenCalledTimes(1);
    });
});

describe('router writes', () => {
    it('applies a valid setting through the patch path and echoes it to the writer', () => {
        const { actions, published, write } = setup();
        const ops: PatchOp[] = [{ op: 'replace', path: '/modules/m1/settings/volume', value: 120 }];
        expect(write(ops)).toEqual({ rejected: [] });
        expect(actions.patch).toHaveBeenCalledWith('s1', ops);
        expect(published).toHaveBeenCalledWith(ops, { origin: 's1', writeId: 7 });
    });

    it('rejects per op: range, type, read-only, undeclared, structure', () => {
        const { actions, write } = setup();
        const result = write([
            { op: 'replace', path: '/modules/m1/settings/volume', value: 999 },
            { op: 'replace', path: '/modules/m1/settings/channels', value: 2.5 },
            { op: 'replace', path: '/modules/m1/settings/detected', value: 'x' },
            { op: 'replace', path: '/modules/m1/settings/bogus', value: 1 },
            { op: 'add', path: '/connections/-', value: {} },
            { op: 'replace', path: '/modules/m1/displayName', value: 'x' },
            { op: 'replace', path: '/modules/zz/enabled', value: false },
            { op: 'replace', path: '/modules/m1/enabled', value: false },
        ]);
        expect(result.rejected.map((r) => [r.index, r.reason])).toEqual([
            [0, 'above maximum 150'],
            [1, 'expected integer'],
            [2, 'read-only'],
            [3, 'unknown value'],
            [4, 'not writable on a router'],
            [5, 'not writable on a router'],
            [6, 'unknown module'],
        ]);
        expect(actions.patch).toHaveBeenCalledWith('s1', [{ op: 'replace', path: '/modules/m1/enabled', value: false }]);
    });

    it('checks a batch against its own earlier ops (x-maxFrom)', () => {
        const { write } = setup();
        const result = write([
            { op: 'replace', path: '/modules/m1/settings/ceiling', value: 20 },
            { op: 'replace', path: '/modules/m1/settings/gain', value: 15 },
        ]);
        expect(result.rejected).toEqual([]);
        // The next batch starts from the stored config, now ceiling 20.
        expect(write([{ op: 'replace', path: '/modules/m1/settings/gain', value: 25 }]).rejected[0].reason).toBe('above maximum 20');
    });

    it('info/running goes to the run controller', () => {
        const { actions, published, write } = setup();
        expect(write([{ op: 'replace', path: '/info/running', value: false }]).rejected).toEqual([]);
        expect(actions.setRunning).toHaveBeenCalledWith(false);
        expect(actions.patch).not.toHaveBeenCalled();
        expect(published).toHaveBeenCalledWith([{ op: 'replace', path: '/info/running', value: false }], { origin: 's1', writeId: 7 });
        expect(write([{ op: 'replace', path: '/info/running', value: 'yes' }]).rejected[0].reason).toBe('expected boolean');
    });
});

describe('router calls', () => {
    it('restarts a module', () => {
        const { actions } = setup();
        routerCall(actions, '/modules/m1', 'restart', {});
        expect(actions.restartModule).toHaveBeenCalledWith('m1');
    });

    it('reboots at once with a manager, only with confirm without one', () => {
        const { actions } = setup();
        routerCall(actions, '/', 'reboot', {});
        expect(actions.reboot).toHaveBeenCalledTimes(1);
        vi.mocked(actions.managerConnected).mockReturnValue(false);
        expect(() => routerCall(actions, '/', 'reboot', {})).toThrow(TreeCallError);
        expect(actions.reboot).toHaveBeenCalledTimes(1);
        routerCall(actions, '/', 'reboot', { confirm: true });
        expect(actions.reboot).toHaveBeenCalledTimes(2);
    });

    it('fails an unknown method', () => {
        const { actions } = setup();
        expect(() => routerCall(actions, '/modules/m1', 'explode', {})).toThrow('no method explode on /modules/m1');
    });
});

describe('router /meta', () => {
    afterEach(() => vi.useRealTimers());

    /** A socket subscribed to `patterns`; `sent()` = the ops it received so far. */
    function named(tree: RouterTree, patterns: string[]) {
        const s = fakeSocket('d');
        tree.bus.attach(s);
        tree.bus.subscribe('d', patterns);
        return () => {
            vi.advanceTimersByTime(60);
            return s.frames().flat();
        };
    }

    it('serves descriptors beside the tree, not under `/`; only enabled among module fields', () => {
        const { view } = setup();
        expect(view.get(['meta', 'modules', 'm1', 'settings', 'volume'])).toMatchObject({ access: 'write', apply: 'live', max: 150 });
        expect(view.get(['meta', 'modules', 'm1', 'settings', 'detected'])).toMatchObject({ access: 'read' });
        expect(Object.keys(view.get(['meta', 'modules', 'm1']) as object).sort()).toEqual(['enabled', 'settings', 'statusData']);
        expect(view.get(['meta', 'info', 'running'])).toMatchObject({ access: 'write', type: 'boolean' });
        expect(view.keys([])).not.toContain('meta');
    });

    it('republishes a descriptor when a manager push changes its inputs', () => {
        vi.useFakeTimers();
        const { tree, config } = setup();
        const sent = named(tree, ['/meta/modules/m1/settings/gain']);
        // gain's max follows `ceiling` (x-maxFrom).
        config.modules.m1.settings.ceiling = 25;
        tree.config([{ op: 'replace', path: '/modules/m1/settings/ceiling', value: 25 }]);
        expect(sent().find((o) => o.path === '/meta/modules/m1')?.value.settings.gain.max).toBe(25);
    });

    it('a write on the router tree itself refreshes the descriptors it changed', () => {
        vi.useFakeTimers();
        const { tree, write } = setup();
        const sent = named(tree, ['/meta/modules/m1/settings/gain']);
        expect(write([{ op: 'replace', path: '/modules/m1/settings/ceiling', value: 30 }]).rejected).toEqual([]);
        expect(sent().find((o) => o.path === '/meta/modules/m1')?.value.settings.gain.max).toBe(30);
        write([{ op: 'replace', path: '/modules/m1/settings/ceiling', value: 40 }]);
        expect(sent()).toContainEqual({ op: 'replace', path: '/meta/modules/m1/settings/gain/max', value: 40 });
    });
});
