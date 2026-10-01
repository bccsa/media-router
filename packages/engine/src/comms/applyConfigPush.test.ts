import { describe, it, expect, vi } from 'vitest';
import { applyConfigPush, type ConfigPushDeps } from './applyConfigPush.js';
import { LocalChanges } from './LocalChanges.js';

const config = (volume: number) => ({ modules: { m1: { pluginId: 'mixer', settings: { volume } } }, connections: [], running: true });

function setup(opts: { running?: boolean; current?: Record<string, unknown> | null; profile?: string } = {}) {
    let current: Record<string, unknown> | null = opts.current === undefined ? config(100) : opts.current;
    const link = { isConnected: true, send: vi.fn() };
    const localChanges = new LocalChanges(link);
    localChanges.profile = opts.profile ?? 'p';
    const deps: ConfigPushDeps = {
        localChanges,
        getConfig: () => current,
        setConfig: vi.fn((c) => (current = c)),
        isRunning: () => opts.running ?? true,
        applyOps: vi.fn(),
        broadcastConfig: vi.fn(),
        restartAll: vi.fn(),
    };
    return { deps, link, localChanges, current: () => current };
}

describe('applyConfigPush', () => {
    it('reconnect of the running profile applies only the difference, and keeps the config object', () => {
        const { deps, current } = setup();
        const before = current();
        applyConfigPush(deps, { ...config(80), running: false, _push: { reason: 'connect', profile: 'p' } });
        expect(deps.applyOps).toHaveBeenCalledWith([{ op: 'replace', path: '/modules/m1/settings/volume', value: 80 }]);
        expect(deps.setConfig).not.toHaveBeenCalled();
        expect(current()).toBe(before);
        expect(current()!.running).toBe(false);
    });

    it('an outage edit survives the reconnect: nothing is re-applied, the journal goes up', () => {
        const { deps, link, localChanges } = setup();
        localChanges.config([{ op: 'replace', path: '/modules/m1/settings/volume', value: 60 }]);
        deps.getConfig()!.modules = config(60).modules;
        applyConfigPush(deps, { ...config(100), _push: { reason: 'connect', profile: 'p' } });
        expect(deps.applyOps).not.toHaveBeenCalled();
        expect(link.send).toHaveBeenCalledWith(
            'patch',
            { ops: [{ op: 'replace', path: '/modules/m1/settings/volume', value: 60 }] },
            { guaranteeDelivery: true },
        );
    });

    it('an activation replaces the config', () => {
        const { deps } = setup();
        applyConfigPush(deps, { ...config(80), _push: { reason: 'activate', profile: 'p' } });
        expect(deps.setConfig).toHaveBeenCalledWith(config(80));
        expect(deps.broadcastConfig).toHaveBeenCalled();
        expect(deps.applyOps).not.toHaveBeenCalled();
        expect(deps.restartAll).not.toHaveBeenCalled();
    });

    it('a profile switched during the outage rebuilds the running modules', () => {
        const { deps } = setup();
        applyConfigPush(deps, { ...config(80), _push: { reason: 'connect', profile: 'other' } });
        expect(deps.setConfig).toHaveBeenCalled();
        expect(deps.restartAll).toHaveBeenCalled();
    });

    it('stopped, first boot, or an untagged push: plain replace', () => {
        for (const opts of [{ running: false }, { current: null }]) {
            const { deps } = setup(opts);
            applyConfigPush(deps, { ...config(80), _push: { reason: 'connect', profile: 'p' } });
            expect(deps.setConfig).toHaveBeenCalled();
            expect(deps.applyOps).not.toHaveBeenCalled();
        }
        const { deps } = setup();
        applyConfigPush(deps, config(80));
        expect(deps.setConfig).toHaveBeenCalledWith(config(80));
    });

    it('never runs a pushed config with two members of an interlock live; the mute goes up after the sync', () => {
        const { deps, link } = setup({ current: null });
        applyConfigPush(deps, {
            modules: { a: { settings: { audioEnabled: true } }, b: { settings: { audioEnabled: true } } },
            connections: [],
            interlocks: [{ id: 'ilk-1', name: 'Mics', members: ['a', 'b'] }],
            _push: { reason: 'activate', profile: 'p' },
        });
        const ran = (deps.setConfig as any).mock.calls[0][0];
        expect([ran.modules.a.settings.audioEnabled, ran.modules.b.settings.audioEnabled]).toEqual([true, false]);
        expect(link.send).toHaveBeenCalledWith(
            'patch',
            { ops: [{ op: 'replace', path: '/modules/b/settings/audioEnabled', value: false }] },
            { guaranteeDelivery: true },
        );
    });
});

