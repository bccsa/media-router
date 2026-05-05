/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { computeAutoLayout, type LayoutNode, type LayoutEdge } from './autoLayout';

function n(id: string, x = 0, y = 0, width?: number, height?: number): LayoutNode {
    return {
        id,
        position: { x, y },
        data: width || height ? { size: { width, height } } : {},
    };
}

function e(source: string, target: string): LayoutEdge {
    return { source, target };
}

describe('computeAutoLayout', () => {
    it('returns an empty map for an empty graph', () => {
        expect(computeAutoLayout([], []).size).toBe(0);
    });

    it('places isolated nodes all on layer 0 (same x)', () => {
        const positions = computeAutoLayout([n('a'), n('b'), n('c')], []);
        const xs = new Set(Array.from(positions.values(), (p) => p.x));
        expect(xs.size).toBe(1);
        expect(positions.size).toBe(3);
    });

    it('puts source and sink in different layers (source.x < sink.x)', () => {
        const positions = computeAutoLayout([n('src'), n('dst')], [e('src', 'dst')]);
        expect(positions.get('src')!.x).toBeLessThan(positions.get('dst')!.x);
    });

    it('promotes a node to a later layer when it has multiple ancestor depths', () => {
        // a → b → c, and a → c — c should land in layer 2, not layer 1.
        const positions = computeAutoLayout(
            [n('a'), n('b'), n('c')],
            [e('a', 'b'), e('b', 'c'), e('a', 'c')],
        );
        const xs = [positions.get('a')!.x, positions.get('b')!.x, positions.get('c')!.x];
        expect(xs[0]).toBeLessThan(xs[1]);
        expect(xs[1]).toBeLessThan(xs[2]);
    });

    it('uses each layer max width when computing the next layer x', () => {
        // Wide source on layer 0 should push layer 1 right.
        const positions = computeAutoLayout(
            [n('wide', 0, 0, 400), n('narrow', 0, 0, 200)],
            [e('wide', 'narrow')],
        );
        // 400 (wide) + 80 gap = 480, snapped to 480
        expect(positions.get('narrow')!.x).toBe(480);
    });

    it('snaps positions to the 16-px grid', () => {
        const positions = computeAutoLayout([n('a'), n('b')], []);
        for (const p of positions.values()) {
            expect(Math.abs(p.x % 16)).toBe(0);
            expect(Math.abs(p.y % 16)).toBe(0);
        }
    });

    it('orders a layer by predecessor barycenter so connected nodes stay aligned', () => {
        // s1 connects to t1, s2 connects to t2. With s1 above s2, t1 should
        // be above t2 regardless of t1/t2's input order or original Y.
        const positions = computeAutoLayout(
            [
                n('s1', 0, -200),
                n('s2', 0, 200),
                n('t1', 0, 999), // deliberately misordered
                n('t2', 0, -999),
            ],
            [e('s1', 't1'), e('s2', 't2')],
        );
        expect(positions.get('t1')!.y).toBeLessThan(positions.get('t2')!.y);
    });

    it('skips edges whose endpoints are not in the node set', () => {
        // Edge to/from a missing node must not throw or affect placement.
        expect(() => computeAutoLayout([n('a')], [e('a', 'ghost')])).not.toThrow();
    });

    it('breaks a cycle by seeding a back-edge target as a source', () => {
        // a ↔ b — neither has in-degree 0. Layout should still place them
        // in different layers rather than piling both at layer 0.
        const positions = computeAutoLayout([n('a'), n('b')], [e('a', 'b'), e('b', 'a')]);
        expect(positions.size).toBe(2);
        expect(positions.get('a')!.x).not.toBe(positions.get('b')!.x);
    });

    it('does not pile cycle members on top of a real source', () => {
        // src is a true source; a ↔ b form a cycle disconnected from src.
        // The cycle should land on later layers, not pile onto src's column.
        const positions = computeAutoLayout(
            [n('src'), n('a'), n('b')],
            [e('a', 'b'), e('b', 'a')],
        );
        const srcX = positions.get('src')!.x;
        expect(positions.get('a')!.x).not.toBe(srcX);
        expect(positions.get('b')!.x).not.toBe(srcX);
    });
});
