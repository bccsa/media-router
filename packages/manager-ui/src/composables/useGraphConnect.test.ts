import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed } from 'vue';
import type { Connection } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';

const mocks = vi.hoisted(() => ({
    addConnection: vi.fn(),
    toast: vi.fn(),
    storeEngine: undefined as unknown,
}));
vi.mock('@/composables/usePatch', () => ({
    patch: { addConnection: (...args: unknown[]) => mocks.addConnection(...args) },
}));
vi.mock('@/composables/useToast', () => ({
    useToast: () => ({ show: (...args: unknown[]) => mocks.toast(...args) }),
}));
vi.mock('@/stores/engines', () => ({
    useEngineStore: () => ({ getEngine: () => mocks.storeEngine }),
}));

import { connectPorts, useGraphConnect } from './useGraphConnect';

const port = (id: string, direction: string, streamType: string, maxConnections = -1) => ({
    id,
    label: id,
    direction,
    streamType,
    maxConnections,
});

/** enc → dec (single-feed input, already fed by enc2); dec2 free; pcm a PipeWire input. */
function makeEngine(): EngineState {
    return {
        engineId: 'eng-1',
        modules: {
            enc: { instanceId: 'enc', ports: [port('out', 'output', 'audio/302m')] },
            enc2: { instanceId: 'enc2', ports: [port('out', 'output', 'audio/302m')] },
            dec: { instanceId: 'dec', ports: [port('in', 'input', 'audio/302m', 1)] },
            dec2: { instanceId: 'dec2', ports: [port('in', 'input', 'audio/302m', 1)] },
            pcm: { instanceId: 'pcm', ports: [port('in', 'input', 'audio/pcm')] },
        },
        connections: [
            {
                id: 'enc2:out-dec:in',
                sourceModuleId: 'enc2',
                sourcePortId: 'out',
                sinkModuleId: 'dec',
                sinkPortId: 'in',
            },
        ],
    } as unknown as EngineState;
}

const ENC_DEC2 = {
    id: 'enc:out-dec2:in',
    sourceModuleId: 'enc',
    sourcePortId: 'out',
    sinkModuleId: 'dec2',
    sinkPortId: 'in',
};

beforeEach(() => {
    mocks.addConnection.mockReset();
    mocks.toast.mockReset();
    mocks.storeEngine = makeEngine();
});

describe('connectPorts', () => {
    it('writes output → input with the derived id', () => {
        const v = connectPorts(
            'eng-1',
            { moduleId: 'enc', portId: 'out' },
            { moduleId: 'dec2', portId: 'in' },
        );
        expect(v).toEqual({ ok: true });
        expect(mocks.addConnection).toHaveBeenCalledWith('eng-1', ENC_DEC2);
    });

    it('turns an input-first pair around', () => {
        connectPorts(
            'eng-1',
            { moduleId: 'dec2', portId: 'in' },
            { moduleId: 'enc', portId: 'out' },
        );
        expect(mocks.addConnection).toHaveBeenCalledWith('eng-1', ENC_DEC2);
    });

    it.each([
        ['an incompatible stream type', 'pcm', 'in', /incompatible/],
        ['a full single-feed input', 'dec', 'in', /1-connection limit/],
        ['a missing port', 'dec2', 'nope', /Port not found/],
    ])('refuses %s, says why and writes nothing', (_what, moduleId, portId, reason) => {
        const v = connectPorts('eng-1', { moduleId: 'enc', portId: 'out' }, { moduleId, portId });
        expect(v.ok).toBe(false);
        expect(!v.ok && v.reason).toMatch(reason);
        expect(mocks.addConnection).not.toHaveBeenCalled();
        expect(mocks.toast).not.toHaveBeenCalled();
    });
});

describe('useGraphConnect', () => {
    const drag = (source: string, sourceHandle: string, target: string, targetHandle: string) =>
        ({ source, sourceHandle, target, targetHandle }) as Connection;

    function setup() {
        const engine = computed(() => makeEngine());
        return useGraphConnect(() => 'eng-1', engine);
    }

    it('onConnect persists a valid drag from either end', () => {
        const g = setup();
        g.onConnect(drag('dec2', 'in', 'enc', 'out'));
        expect(mocks.addConnection).toHaveBeenCalledWith('eng-1', ENC_DEC2);
        expect(mocks.toast).not.toHaveBeenCalled();
    });

    it('onConnect explains a refused drag in a toast', () => {
        const g = setup();
        g.onConnect(drag('enc', 'out', 'pcm', 'in'));
        expect(mocks.addConnection).not.toHaveBeenCalled();
        expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/incompatible/));
    });

    it('isValidConnection follows the same rules', () => {
        const g = setup();
        expect(g.isValidConnection(drag('enc', 'out', 'dec2', 'in'))).toBe(true);
        expect(g.isValidConnection(drag('enc', 'out', 'dec', 'in'))).toBe(false);
    });
});
