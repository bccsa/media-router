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

function services(named = true): ModuleServices {
    return {
        instanceId: 'mixer-1',
        mediaRouter: {
            ...(named ? { moduleName: (id: string) => (id === 'src-a' ? 'Chat IN' : id) } : {}),
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
    it('names the producer by its display name, through the connection records (they outlive the bus port)', () => {
        expect(describeLiveInputBranch(plugin(), services(), 'mixin_in_c1')).toBe('Chat IN');
        // No resolver (a harness): the module id, never the bin name.
        expect(describeLiveInputBranch(plugin(), services(false), 'mixin_in_c1')).toBe('src-a');
    });

    it('falls back to the bin name when no incoming edge matches', () => {
        expect(describeLiveInputBranch(plugin(), services(), 'mixin_in_zz')).toBe('mixin_in_zz');
    });
});

describe('LostInputs', () => {
    it('names every missing input and clears only when the last is back', () => {
        const lost = new LostInputs();
        expect(lost.lose('a', 'ENG IN')).toBe('Input from ENG IN lost — continuing without it');
        expect(lost.lose('b', 'SWA IN')).toContain('ENG IN, SWA IN lost');
        expect(lost.restore('a')).toBe('Input from SWA IN lost — continuing without it');
        expect(lost.restore('b')).toBeNull();
        expect(lost.size).toBe(0);
    });

    it('a source that never ran is "not running", not "lost" (B-194)', () => {
        const lost = new LostInputs();
        expect(lost.lose('c', 'Chat IN', 'not-running')).toBe(
            'Input from Chat IN not running — continuing without it',
        );
        expect(lost.lose('a', 'ENG IN')).toBe(
            'Input from ENG IN lost, from Chat IN not running — continuing without it',
        );
        expect(lost.has('c')).toBe(true);
        // Two edges from one producer: its name once.
        lost.lose('d', 'Chat IN', 'not-running');
        expect(lost.warning()).toBe(
            'Input from ENG IN lost, from Chat IN not running — continuing without it',
        );
        // A join after its launch, then a loss: what happened last is what it says.
        lost.restore('d');
        expect(lost.lose('c', 'Chat IN')).toBe(
            'Input from Chat IN, ENG IN lost — continuing without it',
        );
    });
});
