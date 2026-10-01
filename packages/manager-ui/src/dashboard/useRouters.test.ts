/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { defineComponent, h, reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useRouters } from './useRouters';
import type { DashboardSource } from './source';

function source(data: Record<string, unknown>) {
    const d = reactive(data);
    return { prefix: '', connected: ref(true), get: (p: string) => d[p], loaded: () => true, subscribe: () => () => {} } as unknown as DashboardSource;
}

function routersOf(src: DashboardSource) {
    let r!: ReturnType<typeof useRouters>;
    mount(defineComponent({ setup: () => ((r = useRouters(src, () => true)), () => h('div')) }));
    return r;
}

describe('useRouters: the routing view grouping', () => {
    it('groups routers like the sidebar: group order, then order within the group', () => {
        const r = routersOf(
            source({
                '/groups': {
                    ungrouped: { name: 'Ungrouped', sort_order: 99 },
                    cm: { name: 'Cameroon', sort_order: 2, color: '#f00' },
                    cd: { name: 'Congo', sort_order: 1 },
                },
                '/engines': {
                    b: { info: { name: 'CM-DO-Link01', groupId: 'cm', sortOrder: 1 } },
                    a: { info: { name: 'CM-BV-Gate01', groupId: 'cm', sortOrder: 0 } },
                    c: { info: { name: 'CD-JDP-Gate01', groupId: 'cd' } },
                    d: { info: { name: 'Lab', groupId: 'gone' } },
                    e: { info: {} },
                },
            }),
        );
        expect(r.groups.value.map((g) => [g.name, g.routers.map((x) => x.name)])).toEqual([
            ['Congo', ['CD-JDP-Gate01']],
            ['Cameroon', ['CM-BV-Gate01', 'CM-DO-Link01']],
            ['Ungrouped', ['e', 'Lab']],
        ]);
        expect(r.options.value[1]).toEqual({ value: 'a', label: 'CM-BV-Gate01', group: 'Cameroon' });
    });
});
