// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';

const log: string[] = [];
const subscribe = vi.fn((patterns: string[]) => {
    log.push(`sub ${patterns.join(',')}`);
    return () => log.push(`release ${patterns.join(',')}`);
});
vi.mock('@/stores/socket', () => ({ useSocketStore: () => ({ subscribe }) }));

import { useTopics } from './useTopics';

describe('useTopics', () => {
    it('subscribes the new set before releasing the old, and releases on unmount', async () => {
        const patterns = ref(['/engines/a']);
        const C = defineComponent({
            setup() {
                useTopics(() => patterns.value);
                return () => h('div');
            },
        });
        const w = mount(C);
        patterns.value = ['/engines/b'];
        await nextTick();
        patterns.value = [];
        await nextTick();
        patterns.value = ['/engines/c'];
        await nextTick();
        w.unmount();
        expect(log).toEqual([
            'sub /engines/a',
            'sub /engines/b',
            'release /engines/a',
            'release /engines/b',
            'sub /engines/c',
            'release /engines/c',
        ]);
    });
});
