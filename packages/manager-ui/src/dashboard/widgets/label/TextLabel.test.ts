/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import TextLabel from './TextLabel.vue';

const label = (options: Record<string, unknown>) =>
    mount(TextLabel, { props: { widget: { id: 'l', type: 'label', x: 0, y: 0, w: 4, h: 1 }, value: undefined, interactive: false, label: '', options: { text: 'Audio IN', ...options } } as any });
const box = (w: ReturnType<typeof label>) => (w.find('.lb').element as HTMLElement).style;
const text = (w: ReturnType<typeof label>) => w.find('.lb-text');

describe('TextLabel', () => {
    it('places the text by both aligns', () => {
        const w = label({ align: 'right', valign: 'bottom' });
        expect([box(w).justifyContent, box(w).alignItems]).toEqual(['flex-end', 'flex-end']);
        expect((text(w).element as HTMLElement).style.textAlign).toBe('right');
    });

    it('auto: a frame’s title on top, plain text in the middle', () => {
        expect(box(label({ frame: true, valign: 'auto' })).alignItems).toBe('flex-start');
        expect(box(label({ valign: 'auto' })).alignItems).toBe('center');
    });

    it('turns the text for vertical; its lines follow the vertical align', () => {
        const up = label({ orientation: 'up', valign: 'bottom' });
        expect(text(up).classes()).toContain('lb-up');
        // Reading up, a line starts at the bottom.
        expect((text(up).element as HTMLElement).style.textAlign).toBe('start');
        const down = label({ orientation: 'down', valign: 'bottom' });
        expect(text(down).classes()).toContain('lb-down');
        expect((text(down).element as HTMLElement).style.textAlign).toBe('end');
        expect(text(label({ orientation: 'horizontal' })).classes()).not.toContain('lb-up');
    });
});
