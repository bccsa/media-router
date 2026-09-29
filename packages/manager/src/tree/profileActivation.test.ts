import { describe, it, expect, vi } from 'vitest';
import { activateProfile } from './profileActivation.js';

function setup(opts: { online?: boolean; running?: Record<string, boolean> } = {}) {
    let active = 'a';
    const running = opts.running ?? { a: true, b: true };
    const configStore = {
        getProfile: vi.fn((_e: string, name: string) => (name in running ? { modules: {}, running: running[name] } : undefined)),
        setActiveProfile: vi.fn((_e: string, name: string) => (active = name)),
    } as any;
    const engineManager = { isEngineOnline: vi.fn(() => opts.online ?? true), sendToEngine: vi.fn() } as any;
    const engineCommands = { isRunning: vi.fn(() => running[active]), sendCommand: vi.fn() } as any;
    const publisher = { graph: vi.fn() } as any;
    const deps = { configStore, engineManager, engineCommands, publisher };
    return { deps, configStore, engineManager, engineCommands, publisher };
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

    it('an unknown profile is an error', () => {
        const { deps, configStore } = setup();
        expect(activateProfile(deps, 'e1', 'zz')).toBe('Profile not found');
        expect(configStore.setActiveProfile).not.toHaveBeenCalled();
    });
});
