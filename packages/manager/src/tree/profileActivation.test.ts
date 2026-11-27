import { describe, it, expect, vi } from 'vitest';
import { activateProfile } from './profileActivation.js';

function setup(opts: { online?: boolean; running?: Record<string, boolean>; modules?: Record<string, string[]> } = {}) {
    let active = 'a';
    const running = opts.running ?? { a: true, b: true };
    const modulesOf = (name: string) => Object.fromEntries((opts.modules?.[name] ?? []).map((id) => [id, {}]));
    const configStore = {
        getProfile: vi.fn((_e: string, name: string) => (name in running ? { modules: modulesOf(name), running: running[name] } : undefined)),
        getEngine: vi.fn(() => ({ active_profile: active })),
        setActiveProfile: vi.fn((_e: string, name: string) => (active = name)),
    } as any;
    const engineManager = { isEngineOnline: vi.fn(() => opts.online ?? true), sendToEngine: vi.fn() } as any;
    const engineCommands = { isRunning: vi.fn(() => running[active]), sendCommand: vi.fn() } as any;
    const publisher = { graph: vi.fn() } as any;
    const runtime = { clearModuleTombstones: vi.fn(), purgeModuleStates: vi.fn() } as any;
    const deps = { configStore, engineManager, engineCommands, runtime, publisher };
    return { deps, configStore, engineManager, engineCommands, runtime, publisher };
}

describe('activateProfile', () => {
    it('a running profile: start, which pushes the config first', () => {
        const { deps, engineCommands, engineManager, publisher } = setup();
        expect(activateProfile(deps, 'e1', 'b')).toBeNull();
        expect(engineCommands.sendCommand).toHaveBeenCalledWith('e1', 'start');
        expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        expect(publisher.graph).toHaveBeenCalledWith('e1');
    });

    it('a stopped profile: tagged config push, then stop if the old one ran', () => {
        const { deps, engineCommands, engineManager } = setup({ running: { a: true, b: false } });
        activateProfile(deps, 'e1', 'b');
        expect(engineManager.sendToEngine).toHaveBeenCalledWith(
            'e1',
            'config',
            { modules: {}, running: false, _push: { reason: 'activate', profile: 'b' } },
            { guaranteeDelivery: true },
        );
        expect(engineCommands.sendCommand).toHaveBeenCalledWith('e1', 'stop');
    });

    it('offline: only the stored choice changes', () => {
        const { deps, configStore, engineManager, engineCommands } = setup({ online: false });
        activateProfile(deps, 'e1', 'b');
        expect(configStore.setActiveProfile).toHaveBeenCalledWith('e1', 'b');
        expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        expect(engineCommands.sendCommand).not.toHaveBeenCalled();
    });

    it("lifts the new profile's tombstones and purges the ids it drops (MR-067)", () => {
        const { deps, runtime } = setup({ modules: { a: ['m1', 'm3'], b: ['m1', 'm4'] } });
        activateProfile(deps, 'e1', 'b');
        expect(runtime.clearModuleTombstones).toHaveBeenCalledWith('e1', ['m1', 'm4']);
        expect(runtime.purgeModuleStates).toHaveBeenCalledWith('e1', ['m3']);
    });

    it('an unknown profile is an error', () => {
        const { deps, configStore } = setup();
        expect(activateProfile(deps, 'e1', 'zz')).toBe('Profile not found');
        expect(configStore.setActiveProfile).not.toHaveBeenCalled();
    });
});
