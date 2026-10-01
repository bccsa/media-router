/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { defineComponent, h, reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useValue, type Binding } from './useValue';
import type { DashboardSource } from './source';

/** A source over a plain map: `data` holds values, `answered` the loaded patterns. */
function fakeSource(prefix = '') {
    const data = reactive<Record<string, unknown>>({});
    const answered = reactive(new Set<string>());
    const connected = ref(true);
    const source = {
        prefix,
        connected,
        get: (p: string) => data[p],
        loaded: (p: string) => answered.has(p),
        subscribe: (patterns: string[]) => {
            patterns.forEach((p) => answered.add(p));
            return () => {};
        },
        write: async () => ({ rejected: [] }),
        call: async () => ({}) as any,
        close() {},
    } as unknown as DashboardSource;
    return { source, data, connected };
}

function bind(source: DashboardSource, rel: string, offline = () => false): Binding {
    let b!: Binding;
    mount(defineComponent({ setup: () => ((b = useValue(source, () => rel, offline)), () => h('div')) }));
    return b;
}

describe('useValue states', () => {
    it('a module that exists but reports no levels yet is ok, not missing', () => {
        const { source, data } = fakeSource('/engines/e1');
        data['/engines/e1/modules/m1/pluginId'] = 'audio-transcoder';
        expect(bind(source, '/modules/m1/vu').state.value).toBe('ok');
    });

    it('a value of a module that is gone is missing', () => {
        const { source } = fakeSource('/engines/e1');
        expect(bind(source, '/modules/m9/settings/volume').state.value).toBe('missing');
    });

    it('a known value goes stale when the link or the router is down, and gets a built-in descriptor', () => {
        const { source, data, connected } = fakeSource();
        data['/system/cpu'] = 30;
        const offline = ref(false);
        const b = bind(source, '/system/cpu', () => offline.value);
        expect(b.state.value).toBe('ok');
        expect(b.desc.value).toMatchObject({ min: 0, max: 100, unit: '%' });
        offline.value = true;
        expect(b.state.value).toBe('stale');
        offline.value = false;
        connected.value = false;
        expect(b.state.value).toBe('stale');
    });

    it('a router known to be down is stale even when its values went with it', () => {
        const { source } = fakeSource();
        expect(bind(source, '/system/cpu', () => true).state.value).toBe('stale');
    });
});
