import { describe, it, expect } from 'vitest';
import {
    annotateLiveInputBranches,
    describeLiveInputBranch,
    LostInputs,
} from './liveInputBranches.js';
import type { ModuleServices, PipelineDescription, PluginModule } from './PluginModule.js';

function plugin(withHook = true): PluginModule {
    return {
        getLiveInputBranch: withHook
            ? (port: string, conn: string) => ({ element: 'mixin', name: `mixin_in_${conn}` })
            : undefined,
    } as unknown as PluginModule;
}

function services(): ModuleServices {
    return {
        instanceId: 'mixer-1',
        mediaRouter: {
            getModuleBusSources: () => [
                { sinkPortId: 'audio-in', connectionId: 'c1' },
                { sinkPortId: 'audio-in', connectionId: 'c2' },
            ],
            getModuleConnections: () => [
                {
                    id: 'c1',
                    sourceModuleId: 'src-a',
                    sinkModuleId: 'mixer-1',
                    sinkPortId: 'audio-in',
                },
                {
                    id: 'out',
                    sourceModuleId: 'mixer-1',
                    sinkModuleId: 'hop',
                    sinkPortId: 'audio-in',
                },
            ],
        },
    } as unknown as ModuleServices;
}

describe('annotateLiveInputBranches', () => {
    it('lists one bin name per wired bus source', () => {
        const desc: PipelineDescription = { pipeline: 'x' };
        annotateLiveInputBranches(plugin(), services(), desc);
        expect(desc.liveInputBranches).toEqual(['mixin_in_c1', 'mixin_in_c2']);
    });

    it('leaves the field alone for a module without the hook', () => {
        const desc: PipelineDescription = { pipeline: 'x' };
        annotateLiveInputBranches(plugin(false), services(), desc);
        expect(desc.liveInputBranches).toBeUndefined();
    });
});

describe('describeLiveInputBranch', () => {
    it('names the producer through the connection records (they outlive the bus port)', () => {
        expect(describeLiveInputBranch(plugin(), services(), 'mixin_in_c1')).toBe(
            'src-a (audio-in)',
        );
    });

    it('falls back to the bin name when no incoming edge matches', () => {
        expect(describeLiveInputBranch(plugin(), services(), 'mixin_in_zz')).toBe('mixin_in_zz');
    });
});

describe('LostInputs', () => {
    it('names every missing input and clears only when the last is back', () => {
        const lost = new LostInputs();
        expect(lost.lose('a', 'src-a (audio-in)')).toBe(
            'Input from src-a (audio-in) lost — continuing without it',
        );
        expect(lost.lose('b', 'src-b (audio-in)')).toContain('src-a (audio-in), src-b (audio-in)');
        expect(lost.restore('a')).toBe('Input from src-b (audio-in) lost — continuing without it');
        expect(lost.restore('b')).toBeNull();
        expect(lost.size).toBe(0);
    });
});
