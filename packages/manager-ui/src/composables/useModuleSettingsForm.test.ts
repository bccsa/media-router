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

import {
    INGEST_OFFSET_KEY,
    PID_TRIMS_KEY,
    TIMING_MODE_KEY,
    TRUST_DISABLES_OFFSET_REASON,
    TRUST_TOLERANCE_KEY,
    withIngestTimingSettings,
} from '@media-router/shared-types';
import { matchDisabledWhen, useModuleSettingsForm } from './useModuleSettingsForm';

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

    it('so Apply cannot write it back to the engine: nothing when nothing changed, the change alone after one', () => {
        const module = ref<Record<string, unknown> | undefined>({
            configSchema: {
                properties: {
                    threshold: { type: 'number', default: -35 },
                    dynamicsGraph: GRAPH_PROP,
                },
            },
            settings: { threshold: -20, dynamicsGraph: STALE_GRAPH_VALUE },
        });

        const form = mountForm(module);
        form.applyAll();
        expect(mockModuleSettings).not.toHaveBeenCalled();

        form.updateSetting('threshold', -10);
        form.applyAll();
        expect(mockModuleSettings.mock.calls).toEqual([['eng-1', 'mod-1', { threshold: -10 }]]);
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

/** An srt-input as the engine and the manager inject its timing settings (WI-P5-11). */
function trustIngest(settings: Record<string, unknown>): Ref<Record<string, unknown> | undefined> {
    return ref<Record<string, unknown> | undefined>({
        configSchema: withIngestTimingSettings(
            { properties: { latency: { type: 'number', default: 125 } } },
            { pidTrims: true, pcrLock: true, trust: true },
        ),
        settings,
    });
}

describe('useModuleSettingsForm — disabled with a reason (WI-P5-12)', () => {
    beforeEach(() => {
        mockModuleSetting.mockClear();
        mockModuleSettings.mockClear();
    });

    const fieldOf = (form: Api, key: string) => form.formFields.value.find((f) => f.key === key)!;

    it("carries the manifest's x-disabledWhen and x-disabledReason on O and the trims only", () => {
        const form = mountForm(trustIngest({}));

        for (const key of [INGEST_OFFSET_KEY, PID_TRIMS_KEY]) {
            expect(fieldOf(form, key).disabledWhen).toBe('timingMode=trust');
            expect(fieldOf(form, key).disabledReason).toBe(TRUST_DISABLES_OFFSET_REASON);
        }
        const others = form.formFields.value.filter(
            (f) => f.key !== INGEST_OFFSET_KEY && f.key !== PID_TRIMS_KEY,
        );
        expect(others.map((f) => f.key)).toContain('smoothingCooldownMin');
        for (const f of others) expect(f.disabledWhen).toBeUndefined();
    });

    it('in Trust both are disabled with their stored values kept; in Restamp both are enabled', () => {
        const form = mountForm(
            trustIngest({
                [TIMING_MODE_KEY]: 'trust',
                ingestOffsetMs: 500,
                pidTrimsMs: { '257': 120 },
            }),
        );

        expect(form.isFieldDisabled(fieldOf(form, INGEST_OFFSET_KEY))).toBe(true);
        expect(form.isFieldDisabled(fieldOf(form, PID_TRIMS_KEY))).toBe(true);
        expect(form.isFieldDisabled(fieldOf(form, 'smoothingCooldownMin'))).toBe(false);
        expect(form.isFieldDisabled(fieldOf(form, TIMING_MODE_KEY))).toBe(false);
        expect(form.localSettings.value).toMatchObject({
            ingestOffsetMs: 500,
            pidTrimsMs: { '257': 120 },
        });

        form.updateSetting(TIMING_MODE_KEY, 'restamp');
        expect(form.isFieldDisabled(fieldOf(form, INGEST_OFFSET_KEY))).toBe(false);
        expect(form.isFieldDisabled(fieldOf(form, PID_TRIMS_KEY))).toBe(false);
        expect(form.localSettings.value).toMatchObject({
            ingestOffsetMs: 500,
            pidTrimsMs: { '257': 120 },
        });

        form.updateSetting(TIMING_MODE_KEY, 'trust');
        expect(form.isFieldDisabled(fieldOf(form, INGEST_OFFSET_KEY))).toBe(true);
    });

    it('a write to a disabled setting changes neither the copy nor the engine', () => {
        const form = mountForm(trustIngest({ [TIMING_MODE_KEY]: 'trust', ingestOffsetMs: 500 }));

        form.updateSetting(INGEST_OFFSET_KEY, -40);
        form.updateSetting(PID_TRIMS_KEY, { '256': 30 });
        form.applyAll();

        expect(form.localSettings.value.ingestOffsetMs).toBe(500);
        expect(form.localSettings.value.pidTrimsMs).toEqual({});
        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(mockModuleSettings).not.toHaveBeenCalled();
    });

    it('x-showWhen is unchanged: Trust Tolerance shows in Trust only, and is never disabled', () => {
        const form = mountForm(trustIngest({}));
        const tolerance = fieldOf(form, TRUST_TOLERANCE_KEY);

        expect(form.isFieldVisible(tolerance)).toBe(false);
        expect(form.isFieldVisible(fieldOf(form, INGEST_OFFSET_KEY))).toBe(true);
        form.updateSetting(TIMING_MODE_KEY, 'trust');
        expect(form.isFieldVisible(tolerance)).toBe(true);
        expect(form.isFieldDisabled(tolerance)).toBe(false);
        // Disabled, not hidden: O stays on screen, greyed.
        expect(form.isFieldVisible(fieldOf(form, INGEST_OFFSET_KEY))).toBe(true);
    });

    it("matchDisabledWhen takes x-showWhen's form, and no condition never disables", () => {
        const resolve = (key: string) => ({ mode: 'b', on: true })[key];
        expect(matchDisabledWhen({}, resolve)).toBe(false);
        expect(matchDisabledWhen({ disabledWhen: '' }, resolve)).toBe(false);
        expect(matchDisabledWhen({ disabledWhen: 'mode=b' }, resolve)).toBe(true);
        expect(matchDisabledWhen({ disabledWhen: 'mode=a,b' }, resolve)).toBe(true);
        expect(matchDisabledWhen({ disabledWhen: 'mode=a' }, resolve)).toBe(false);
        expect(matchDisabledWhen({ disabledWhen: 'on=true' }, resolve)).toBe(true);
        expect(matchDisabledWhen({ disabledWhen: 'missing=x' }, resolve)).toBe(false);
    });
});
