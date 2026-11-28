// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ConnectionState, ModuleState } from '@/stores/engines';
import type { RefNode, StubEdge } from './crossRefTypes';
import {
    besidePort,
    isEmptyPane,
    stubEdge,
    stubEnds,
    tagAtDrop,
    tagPlace,
    TAG_GAP,
    TAG_SIZE,
} from './xrefCanvas';

const box = {
    position: { x: 100, y: 200 },
    dimensions: { width: 220, height: 120 },
    handleBounds: {
        source: [{ id: 'out', x: 214, y: 54, width: 12, height: 12 }],
        target: [{ id: 'in', x: -6, y: 30, width: 12, height: 12 }],
    },
};

describe('besidePort', () => {
    it('puts an output tag right of its handle, centred on it', () => {
        // handle centre (220, 60) relative → absolute (320, 260)
        expect(besidePort({ kind: 'out', portId: 'out' }, box)).toEqual({
            x: 320 + TAG_GAP,
            y: 260 - TAG_SIZE.height / 2,
        });
    });

    it('puts an input tag left of its handle, using the measured tag size', () => {
        const at = besidePort({ kind: 'in', portId: 'in' }, box, { width: 90, height: 40 });
        // handle centre (0, 36) relative → absolute (100, 236)
        expect(at).toEqual({ x: 100 - TAG_GAP - 90, y: 236 - 20 });
    });

    it('uses the module edge at mid-height before the module is measured', () => {
        const bare = { position: { x: 0, y: 0 } };
        expect(besidePort({ kind: 'out', portId: 'out' }, bare)).toEqual({
            x: 200 + TAG_GAP,
            y: 40 - TAG_SIZE.height / 2,
        });
        expect(besidePort({ kind: 'in', portId: 'in' }, bare).x).toBe(-TAG_GAP - TAG_SIZE.width);
    });

    it('keeps tags beside neighbouring ports apart (ModuleNode port step: 24 px)', () => {
        const twoInputs = {
            ...box,
            handleBounds: {
                target: [
                    { id: 'program-in', x: -6, y: 30, width: 12, height: 12 },
                    { id: 'sidechain-in', x: -6, y: 54, width: 12, height: 12 },
                ],
            },
        };
        const a = besidePort({ kind: 'in', portId: 'program-in' }, twoInputs);
        const b = besidePort({ kind: 'in', portId: 'sidechain-in' }, twoInputs);
        expect(b.y - (a.y + TAG_SIZE.height)).toBeGreaterThan(0);
    });
});

describe('tagPlace', () => {
    const tag = { key: 'out:a:out', kind: 'out', moduleId: 'a', portId: 'out' } as RefNode;
    const find = (id: string) => (id === 'a' ? box : undefined);

    it('keeps a stored place', () => {
        expect(tagPlace({ ...tag, pos: { x: 5, y: 6 } }, find)).toEqual({ x: 5, y: 6 });
    });

    it('reads the measured handle, with the stored module position over the live one', () => {
        const at = tagPlace(tag, find, { x: 0, y: 0 });
        expect(at).toEqual({ x: 220 + TAG_GAP, y: 60 - TAG_SIZE.height / 2 });
        expect(tagPlace(tag, find).x).toBe(320 + TAG_GAP);
    });
});

describe('tagAtDrop', () => {
    it('puts the tag handle under the pointer', () => {
        expect(tagAtDrop('out', { x: 500, y: 300 })).toEqual({
            x: 500,
            y: 300 - TAG_SIZE.height / 2,
        });
        expect(tagAtDrop('in', { x: 500, y: 300 })).toEqual({
            x: 500 - TAG_SIZE.width,
            y: 300 - TAG_SIZE.height / 2,
        });
    });
});

describe('stub edges', () => {
    const outStub: StubEdge = {
        id: 'ref:out:a:out',
        refKey: 'out:a:out',
        kind: 'out',
        moduleId: 'a',
        portId: 'out',
        connectionIds: ['c1', 'c2'],
    };

    it('runs from the module output to the tag, and from the tag to the module input', () => {
        expect(stubEnds(outStub)).toEqual({
            source: 'a',
            sourceHandle: 'out',
            target: 'out:a:out',
            targetHandle: 'tag',
        });
        expect(stubEnds({ kind: 'in', refKey: 'in:b:in', moduleId: 'b', portId: 'in' })).toEqual({
            source: 'in:b:in',
            sourceHandle: 'tag',
            target: 'b',
            targetHandle: 'in',
        });
    });

    const mod = (id: string, running: boolean) =>
        ({
            instanceId: id,
            running,
            ports: [{ id: 'out', direction: 'output', streamType: 'audio/302m' }],
        }) as unknown as ModuleState;
    const conn = (id: string, sink: string) =>
        ({
            id,
            sourceModuleId: 'a',
            sourcePortId: 'out',
            sinkModuleId: sink,
            sinkPortId: 'in',
        }) as ConnectionState;
    const byId = new Map([
        ['c1', conn('c1', 'b')],
        ['c2', conn('c2', 'd')],
    ]);

    it('flows in the feed colour while any connection behind the tag flows', () => {
        const modules = { a: mod('a', true), b: mod('b', false), d: mod('d', true) };
        const edge = stubEdge(outStub, { modules, byId, engineRunning: true, dimmed: false });
        expect(edge.animated).toBe(true);
        expect(edge.style).toMatchObject({ stroke: '#06b6d4', opacity: 1 });
    });

    it('is idle grey when nothing behind it flows, and fades when dimmed', () => {
        const modules = { a: mod('a', true), b: mod('b', false), d: mod('d', false) };
        const edge = stubEdge(outStub, { modules, byId, engineRunning: true, dimmed: true });
        expect(edge.animated).toBe(false);
        expect(edge.style).toMatchObject({ stroke: '#6b7280', opacity: 0.1 });
        const stopped = { a: mod('a', true), b: mod('b', true), d: mod('d', true) };
        expect(
            stubEdge(outStub, { modules: stopped, byId, engineRunning: false, dimmed: false })
                .animated,
        ).toBe(false);
    });
});

describe('isEmptyPane', () => {
    it('is true on the pane and its containers, false on nodes, handles, edges and outside', () => {
        document.body.innerHTML = `
            <div class="vue-flow__pane"><div class="vue-flow__transformationpane" id="t">
                <svg class="vue-flow__edges"><g class="vue-flow__edge"><path id="e"/></g></svg>
                <div class="vue-flow__node" id="n"><div class="vue-flow__handle" id="h"></div></div>
            </div></div>
            <div id="out"></div>`;
        const el = (id: string) => document.getElementById(id);
        expect(isEmptyPane(document.querySelector('.vue-flow__pane'))).toBe(true);
        expect(isEmptyPane(el('t'))).toBe(true);
        expect(isEmptyPane(el('n'))).toBe(false);
        expect(isEmptyPane(el('h'))).toBe(false);
        expect(isEmptyPane(el('e'))).toBe(false);
        expect(isEmptyPane(el('out'))).toBe(false);
        expect(isEmptyPane(null)).toBe(false);
    });
});
