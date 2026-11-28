// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed } from 'vue';
import type { Connection } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';

const m = vi.hoisted(() => ({ addConnection: vi.fn(), toast: vi.fn() }));
vi.mock('@/composables/usePatch', () => ({
    patch: { addConnection: (...a: unknown[]) => m.addConnection(...a) },
}));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ show: m.toast }) }));
vi.mock('@/stores/engines', () => ({ useEngineStore: () => ({ getEngine: () => undefined }) }));

import { useGraphConnect } from './useGraphConnect';

const engine = computed(
    () =>
        ({
            engineId: 'eng-1',
            modules: {
                enc: {
                    instanceId: 'enc',
                    ports: [{ id: 'out', direction: 'output', streamType: 'audio/302m' }],
                },
                dec: {
                    instanceId: 'dec',
                    ports: [{ id: 'in', direction: 'input', streamType: 'audio/302m' }],
                },
            },
            connections: [],
        }) as unknown as EngineState,
);

function setup() {
    const onPaneDrop = vi.fn();
    const g = useGraphConnect(() => 'eng-1', engine, onPaneDrop);
    return { ...g, onPaneDrop };
}

/** What lies under the release point: the empty pane, or a node on it. */
function under(what: 'pane' | 'node' | 'handle') {
    document.body.innerHTML = `
        <div class="vue-flow__pane" id="pane">
            <div class="vue-flow__node" id="node"><div class="vue-flow__handle" id="handle"></div></div>
        </div>`;
    document.elementFromPoint = vi.fn(() => document.getElementById(what));
}

const up = (x: number, y: number) => new MouseEvent('mouseup', { clientX: x, clientY: y });

describe('useGraphConnect: a wire dropped on empty canvas', () => {
    beforeEach(() => {
        m.addConnection.mockReset();
        m.toast.mockReset();
    });

    it('calls onPaneDrop with the port it came from and the release point', () => {
        const { onConnectStart, onConnectEnd, onPaneDrop } = setup();
        under('pane');
        onConnectStart({ nodeId: 'dec', handleId: 'in' });
        onConnectEnd(up(120, 80));
        expect(document.elementFromPoint).toHaveBeenCalledWith(120, 80);
        expect(onPaneDrop).toHaveBeenCalledWith(
            { moduleId: 'dec', portId: 'in', direction: 'input' },
            120,
            80,
        );
    });

    it('does nothing when released on a node or a handle', () => {
        const { onConnectStart, onConnectEnd, onPaneDrop } = setup();
        for (const what of ['node', 'handle'] as const) {
            under(what);
            onConnectStart({ nodeId: 'enc', handleId: 'out' });
            onConnectEnd(up(1, 1));
        }
        expect(onPaneDrop).not.toHaveBeenCalled();
    });

    it('does nothing after the gesture connected (connect-end follows connect)', () => {
        const { onConnectStart, onConnect, onConnectEnd, onPaneDrop } = setup();
        under('pane');
        onConnectStart({ nodeId: 'enc', handleId: 'out' });
        onConnect({
            source: 'enc',
            sourceHandle: 'out',
            target: 'dec',
            targetHandle: 'in',
        } as Connection);
        onConnectEnd(up(1, 1));
        expect(m.addConnection).toHaveBeenCalledTimes(1);
        expect(onPaneDrop).not.toHaveBeenCalled();

        // The next gesture starts clean.
        onConnectStart({ nodeId: 'enc', handleId: 'out' });
        onConnectEnd(up(2, 2));
        expect(onPaneDrop).toHaveBeenCalledTimes(1);
    });

    it('reads a lifted finger from changedTouches', () => {
        const { onConnectStart, onConnectEnd, onPaneDrop } = setup();
        under('pane');
        onConnectStart({ nodeId: 'enc', handleId: 'out' });
        const touch = { clientX: 33, clientY: 44 } as Touch;
        onConnectEnd({ changedTouches: [touch] } as unknown as TouchEvent);
        expect(onPaneDrop).toHaveBeenCalledWith(
            expect.objectContaining({ moduleId: 'enc' }),
            33,
            44,
        );
    });

    it('does nothing for a drag that did not start on a module port', () => {
        const { onConnectStart, onConnectEnd, onPaneDrop } = setup();
        under('pane');
        onConnectEnd(up(1, 1));
        onConnectStart({ nodeId: 'out:enc:out', handleId: 'tag' });
        onConnectEnd(up(1, 1));
        expect(onPaneDrop).not.toHaveBeenCalled();
    });

    it('refuses a connection to a tag, saying how linking works', () => {
        const { onConnect } = setup();
        onConnect({
            source: 'enc',
            sourceHandle: 'out',
            target: 'in:dec:in',
            targetHandle: 'tag',
        } as Connection);
        expect(m.toast).toHaveBeenCalledWith('Drop on empty canvas to link to another page');
        expect(m.addConnection).not.toHaveBeenCalled();
    });
});
