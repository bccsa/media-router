// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import type { StatusGraph } from '@media-router/shared-types';
import GraphWidget from './GraphWidget.vue';

const graph = (over: Partial<StatusGraph> = {}): StatusGraph => ({
    axes: {
        x: { label: 'Input', unit: 'dB', min: -60, max: 0, gridStep: 10, labels: [-60, -20, 0] },
        y: { label: 'Output', unit: 'dB', min: -60, max: 0, gridStep: 10 },
    },
    series: [{ id: 'transfer', points: [[-60, -60], [0, -10]], role: 'primary' }],
    ...over,
});

describe('GraphWidget', () => {
    it('shows an empty state until the plugin publishes data', () => {
        const wrapper = mount(GraphWidget, { props: {} });
        expect(wrapper.find('svg').exists()).toBe(false);
        expect(wrapper.text()).toContain('No graph data yet');
    });

    it('plots each series and captions both axes', () => {
        const wrapper = mount(GraphWidget, { props: { data: graph() } });
        const polylines = wrapper.findAll('polyline');
        expect(polylines).toHaveLength(1);
        // -60 dB lands on the bottom-left corner of the plot box; -10 dB is
        // 5/6 of the way up the 122-unit-tall box on the right edge.
        expect(polylines[0].attributes('points')).toBe('26.0,130.0 252.0,28.3');
        expect(polylines[0].attributes('stroke')).toBe('var(--accent)');
        expect(wrapper.text()).toContain('Input (dB)');
        expect(wrapper.text()).toContain('Output (dB)');
    });

    it('maps roles and stroke hints onto theme tokens', () => {
        const wrapper = mount(GraphWidget, {
            props: {
                data: graph({
                    series: [
                        { id: 'a', points: [[-60, -60], [0, 0]], role: 'muted', stroke: 'dotted' },
                        { id: 'b', points: [[-60, -60], [0, -3]], role: 'error', stroke: 'dashed' },
                    ],
                }),
            },
        });
        const [a, b] = wrapper.findAll('polyline');
        expect(a.attributes('stroke')).toBe('var(--text-muted)');
        expect(a.attributes('stroke-dasharray')).toBe('1 2');
        expect(b.attributes('stroke')).toBe('var(--health-error)');
        expect(b.attributes('stroke-dasharray')).toBe('4 2');
    });

    it('draws marker lines with their labels', () => {
        const wrapper = mount(GraphWidget, {
            props: {
                data: graph({
                    markers: [
                        { axis: 'x', value: -20, label: 'Thr -20 dB', role: 'warning' },
                        { axis: 'y', value: -3, label: 'Ceiling', role: 'error' },
                    ],
                }),
            },
        });
        expect(wrapper.text()).toContain('Thr -20 dB');
        expect(wrapper.text()).toContain('Ceiling');
        // Grid + frame + 2 markers; a vertical marker spans the plot height.
        const vertical = wrapper
            .findAll('line')
            .filter((l) => l.attributes('stroke') === 'var(--health-warning)');
        expect(vertical).toHaveLength(1);
        expect(vertical[0].attributes('y1')).toBe('8');
    });

    it('draws the live dot, and its span band when one is given', () => {
        const plain = mount(GraphWidget, { props: { data: graph({ live: { x: -10, y: -20 } }) } });
        expect(plain.findAll('circle')).toHaveLength(1);
        expect(plain.findAll('rect')).toHaveLength(1); // frame only

        const withSpan = mount(GraphWidget, {
            props: { data: graph({ live: { x: -10, y: -20, span: [-20, -14] } }) },
        });
        expect(withSpan.findAll('rect')).toHaveLength(2);
    });

    it('renders the publisher notes', () => {
        const wrapper = mount(GraphWidget, {
            props: { data: graph({ notes: ['4:1', 'Attack 5 ms'] }) },
        });
        expect(wrapper.text()).toContain('4:1');
        expect(wrapper.text()).toContain('Attack 5 ms');
    });

    it('grids a log axis 1-2-5 per decade and abbreviates the labels', () => {
        const wrapper = mount(GraphWidget, {
            props: {
                data: graph({
                    axes: {
                        x: {
                            label: 'Frequency',
                            unit: 'Hz',
                            min: 20,
                            max: 20000,
                            scale: 'log',
                            labels: [20, 1000, 20000],
                        },
                        y: { label: 'Gain', unit: 'dB', min: -18, max: 18, gridStep: 6 },
                    },
                    series: [{ id: 'response', points: [[20, 0], [20000, 0]] }],
                }),
            },
        });
        expect(wrapper.text()).toContain('Frequency (Hz)');
        expect(wrapper.text()).toContain('1k');
        expect(wrapper.text()).toContain('20k');
    });
});
