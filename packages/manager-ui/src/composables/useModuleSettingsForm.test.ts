/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { computed, defineComponent, nextTick, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';

const mockModuleSetting = vi.fn();
const mockModuleSettings = vi.fn();

vi.mock('@/composables/usePatch', () => ({
    patch: {
        moduleSetting: (...args: unknown[]) => mockModuleSetting(...args),
        moduleSettings: (...args: unknown[]) => mockModuleSettings(...args),
    },
}));

import { useModuleSettingsForm } from './useModuleSettingsForm';

/** A `graph` prop as a plugin declares it: display-only, no `default`. */
const GRAPH_PROP = {
    type: 'object',
    'x-widget': 'graph',
    'x-graph': { section: 'graphs', key: 'dynamics', height: 150 },
};

/** Plot data of the shape a stale saved-settings blob could be carrying. */
const STALE_GRAPH_VALUE = {
    axes: { x: { label: 'Input' }, y: { label: 'Output' } },
    series: [{ id: 'transfer', points: [[-60, -60]] }],
};

type Api = ReturnType<typeof useModuleSettingsForm>;
type ModuleRef = Parameters<typeof useModuleSettingsForm>[0]['module'];

/**
 * Drive the composable inside a real component instance — it registers
 * `onUnmounted`, and the settings watch is `immediate`, so `localSettings` is
 * hydrated by the time `mount` returns.
 */
function mountForm(module: Ref<Record<string, unknown> | undefined>): Api {
    let api!: Api;
    mount(
        defineComponent({
            setup() {
                api = useModuleSettingsForm({
                    engineId: ref('eng-1'),
                    moduleId: ref('mod-1'),
                    // Cast: the composable only reads `configSchema` /
                    // `settings` / `liveUpdatableParams`, so the fixtures
                    // don't need to be whole `ModuleState`s.
                    module: computed(() => module.value) as unknown as ModuleRef,
                });
                return () => null;
            },
        }),
    );
    return api;
}

describe('useModuleSettingsForm — display-widget hydration', () => {
    beforeEach(() => {
        mockModuleSetting.mockClear();
        mockModuleSettings.mockClear();
    });

    it('a stale graph key in saved settings never reaches localSettings', () => {
        const module = ref<Record<string, unknown> | undefined>({
            configSchema: {
                properties: {
                    threshold: { type: 'number', default: -35 },
                    dynamicsGraph: GRAPH_PROP,
                },
            },
            settings: { threshold: -20, dynamicsGraph: STALE_GRAPH_VALUE },
        });

        const { localSettings } = mountForm(module);

        expect(localSettings.value).toEqual({ threshold: -20 });
        expect('dynamicsGraph' in localSettings.value).toBe(false);
    });

    it('so a plain Apply cannot write it back to the engine', () => {
        const module = ref<Record<string, unknown> | undefined>({
            configSchema: {
                properties: {
                    threshold: { type: 'number', default: -35 },
                    dynamicsGraph: GRAPH_PROP,
                },
            },
            settings: { threshold: -20, dynamicsGraph: STALE_GRAPH_VALUE },
        });

        mountForm(module).applyAll();

        expect(mockModuleSettings).toHaveBeenCalledWith('eng-1', 'mod-1', { threshold: -20 });
    });

    it('a later settings push is stripped too, not just the first', async () => {
        const module = ref<Record<string, unknown> | undefined>({
            configSchema: {
                properties: {
                    threshold: { type: 'number', default: -35 },
                    dynamicsGraph: GRAPH_PROP,
                },
            },
            settings: { threshold: -20 },
        });

        const { localSettings } = mountForm(module);
        expect(localSettings.value).toEqual({ threshold: -20 });

        module.value = {
            ...module.value,
            settings: { threshold: -8, dynamicsGraph: STALE_GRAPH_VALUE },
        };
        await nextTick();

        expect(localSettings.value).toEqual({ threshold: -8 });
    });

    it('leaves real settings — including object-valued ones — alone', () => {
        const module = ref<Record<string, unknown> | undefined>({
            configSchema: {
                properties: {
                    threshold: { type: 'number', default: -35 },
                    makeupGain: { type: 'number', default: 0 },
                    channelMap: { type: 'array' },
                    dynamicsGraph: GRAPH_PROP,
                },
            },
            settings: { threshold: -20, channelMap: [{ in: 0, out: 1 }] },
        });

        const { localSettings } = mountForm(module);

        // makeupGain comes from the schema default; the graph prop has none
        // and must not be seeded either.
        expect(localSettings.value).toEqual({
            threshold: -20,
            makeupGain: 0,
            channelMap: [{ in: 0, out: 1 }],
        });
    });
});
