import { describe, it, expect } from 'vitest';
import { edgeColor, edgeStyle, IDLE_EDGE_COLOR } from './edgeStyle';

describe('edgeColor', () => {
    it('colours by stream type and greys an unknown or missing one', () => {
        expect(edgeColor('audio/302m')).toBe('#06b6d4');
        expect(edgeColor('muxed/mpegts')).toBe('#f59e0b');
        expect(edgeColor('bogus')).toBe(IDLE_EDGE_COLOR);
        expect(edgeColor(null)).toBe(IDLE_EDGE_COLOR);
        expect(edgeColor()).toBe(IDLE_EDGE_COLOR);
    });
});

describe('edgeStyle', () => {
    it('fades a dimmed wire', () => {
        expect(edgeStyle('#fff', false)).toMatchObject({ stroke: '#fff', opacity: 1 });
        expect(edgeStyle('#fff', true)).toMatchObject({ opacity: 0.1 });
    });
});
