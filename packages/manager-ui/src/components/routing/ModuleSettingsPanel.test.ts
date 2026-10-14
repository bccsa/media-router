// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const mockCloneModule = vi.fn();
const mockModuleSetting = vi.fn();
const mockModuleSettings = vi.fn();
vi.mock('@/composables/usePatch', () => ({
    patch: {
        cloneModule: (...args: unknown[]) => mockCloneModule(...args),
        moduleSetting: (...args: unknown[]) => mockModuleSetting(...args),
        moduleSettings: (...args: unknown[]) => mockModuleSettings(...args),
        moduleRename: vi.fn(),
        moduleToggle: vi.fn(),
        removeModule: vi.fn(),
    },
}));

import ModuleSettingsPanel from './ModuleSettingsPanel.vue';
import MrMultiSelect from '@/components/common/MrMultiSelect.vue';
import { useEngineStore } from '@/stores/engines';

/**
 * Seed one engine holding one module. No `configSchema` on purpose: that keeps
 * `requiredDeviceTypes` empty so the panel never reaches for the socket on
 * mount, and the form renders no fields.
 */
function seedEngine(mod: Record<string, unknown> = {}) {
    useEngineStore().addEngine({
        engine_id: 'eng-1',
        display_name: 'Test Engine',
        modules: {
            'audio-input-abc': {
                pluginId: 'audio-input',
                displayName: 'Mic 1',
                ...mod,
            },
        },
    });
}

function mountPanel(moduleId = 'audio-input-abc') {
    return mount(ModuleSettingsPanel, { props: { engineId: 'eng-1', moduleId } });
}

describe('ModuleSettingsPanel', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockCloneModule.mockReset();
    });

    it('shows the plugin id alongside the editable display name', () => {
        seedEngine();
        const wrapper = mountPanel();

        expect(wrapper.text()).toContain('audio-input');
        // The name stays in the input, not the type line.
        expect(wrapper.get('input').element.value).toBe('Mic 1');
    });

    it('omits the type line when the module is unknown', () => {
        seedEngine();
        const wrapper = mountPanel('does-not-exist');

        expect(wrapper.text()).not.toContain('audio-input');
    });

    it('emits select with the clone id so the panel switches to the copy (#675)', async () => {
        seedEngine();
        mockCloneModule.mockReturnValue('audio-input-copy');
        const wrapper = mountPanel();

        const cloneBtn = wrapper.findAll('button').find((b) => b.text() === 'Clone');
        await cloneBtn!.trigger('click');

        expect(mockCloneModule).toHaveBeenCalledWith('eng-1', 'audio-input-abc');
        expect(wrapper.emitted('select')).toEqual([['audio-input-copy']]);
    });

    it('does not emit select when the clone fails', async () => {
        seedEngine();
        mockCloneModule.mockReturnValue(undefined);
        const wrapper = mountPanel();

        const cloneBtn = wrapper.findAll('button').find((b) => b.text() === 'Clone');
        await cloneBtn!.trigger('click');

        expect(wrapper.emitted('select')).toBeUndefined();
    });
});

/** srt-input's schema with the two ingest timing settings as WI-P1-9 injects them. */
const SRT_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        host: { type: 'string', default: '0.0.0.0', description: 'Listen or connect address' },
        port: { type: 'number', default: 9000, title: 'Port', description: '' },
        mode: { type: 'string', enum: ['listener', 'caller', 'rendezvous'], default: 'listener' },
        latency: { type: 'number', default: 125, title: 'Latency' },
        playoutOffsetMs: {
            type: 'number',
            minimum: 0,
            maximum: 10000,
            'x-unit': 'ms',
            'x-live': true,
            title: 'Playout Offset',
        },
        ingestOffsetMs: {
            type: 'number',
            default: 0,
            minimum: -10000,
            maximum: 10000,
            'x-unit': 'ms',
            'x-live': true,
            title: 'Ingest Offset',
        },
        pidTrimsMs: {
            type: 'object',
            additionalProperties: { type: 'number', minimum: -2000, maximum: 2000 },
            default: {},
            'x-widget': 'pidTrim',
            'x-optionsFrom': 'pids',
            'x-live': true,
            'x-unit': 'ms',
            title: 'Per-PID Trim',
        },
    },
};

const SRT_PIDS = [
    { value: '256', label: '0x0100 H.264 video' },
    { value: '257', label: '0x0101 AAC audio' },
];

function seedSrtInput(mod: Record<string, unknown> = {}) {
    useEngineStore().addEngine({
        engine_id: 'eng-1',
        display_name: 'Test Engine',
        modules: {
            'srt-input-1': {
                pluginId: 'srt-input',
                displayName: 'Venue feed',
                configSchema: SRT_INPUT_SCHEMA,
                liveUpdatableParams: ['playoutOffsetMs', 'ingestOffsetMs', 'pidTrimsMs'],
                settings: {
                    mode: 'listener',
                    ingestOffsetMs: -40,
                    pidTrimsMs: { '257': 120, '300': 15 },
                },
                fieldOptions: { pids: SRT_PIDS },
                ...mod,
            },
        },
    });
}

/** The block the form renders for one setting: its heading label plus the control. */
function settingBlock(wrapper: VueWrapper, title: string): DOMWrapper<Element> {
    const label = wrapper.findAll('label').find((l) => l.text().startsWith(title));
    if (!label) throw new Error(`no "${title}" setting rendered`);
    return new DOMWrapper(label.element.parentElement!);
}

const shiftOf = (block: DOMWrapper<Element>, pid: string) =>
    block.get(`[data-pid="${pid}"] [data-test="shift"]`).text();

describe('ModuleSettingsPanel — srt-input ingest timing settings', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockModuleSetting.mockReset();
        mockModuleSettings.mockReset();
    });

    it('renders Ingest Offset as a number in ms and Per-PID Trim as the trim widget', () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        const offset = settingBlock(wrapper, 'Ingest Offset');
        const input = offset.get('input[type="number"]').element as HTMLInputElement;
        expect(input.value).toBe('-40');
        expect(input.min).toBe('-10000');
        expect(input.max).toBe('10000');
        expect(offset.text()).toContain('ms');

        const trims = settingBlock(wrapper, 'Per-PID Trim');
        expect(trims.findAll('[data-pid]').map((r) => r.attributes('data-pid'))).toEqual([
            '256',
            '257',
            '300',
        ]);
        expect(trims.text()).toContain('H.264 video');
        expect(trims.get('[data-pid="300"]').text()).toContain('not in stream');
        expect(shiftOf(trims, '256')).toBe('-40');
        expect(shiftOf(trims, '257')).toBe('80');
        // An object value must never reach the array-valued x-optionsFrom multi-select.
        expect(wrapper.findComponent(MrMultiSelect).exists()).toBe(false);
    });

    it('a trim edit patches the whole map live, stale PIDs included', async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await settingBlock(wrapper, 'Per-PID Trim').get('[data-pid="256"] input').setValue('30');

        expect(mockModuleSetting).toHaveBeenCalledWith('eng-1', 'srt-input-1', 'pidTrimsMs', {
            '256': 30,
            '257': 120,
            '300': 15,
        });
    });

    it("clamps a trim to the schema's per-PID bound", async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await settingBlock(wrapper, 'Per-PID Trim').get('[data-pid="257"] input').setValue('2500');

        expect(mockModuleSetting).toHaveBeenCalledWith('eng-1', 'srt-input-1', 'pidTrimsMs', {
            '257': 2000,
            '300': 15,
        });
    });

    it('an Ingest Offset edit moves every shift', async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await settingBlock(wrapper, 'Ingest Offset').get('input').setValue('-100');

        expect(mockModuleSetting).toHaveBeenCalledWith(
            'eng-1',
            'srt-input-1',
            'ingestOffsetMs',
            -100,
        );
        const trims = settingBlock(wrapper, 'Per-PID Trim');
        expect(shiftOf(trims, '256')).toBe('-100');
        expect(shiftOf(trims, '257')).toBe('20');
    });

    it('Save writes the trim map whole beside the offset', async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await wrapper
            .findAll('button')
            .find((b) => b.text() === 'Save')!
            .trigger('click');

        expect(mockModuleSettings).toHaveBeenCalledWith(
            'eng-1',
            'srt-input-1',
            expect.objectContaining({
                ingestOffsetMs: -40,
                pidTrimsMs: { '257': 120, '300': 15 },
            }),
        );
    });

    it('waits for the PMT until the module publishes its PIDs', () => {
        seedSrtInput({ fieldOptions: undefined, settings: {} });
        const wrapper = mountPanel('srt-input-1');

        const trims = settingBlock(wrapper, 'Per-PID Trim');
        expect(trims.text()).toContain("Waiting for the stream's PMT");
        expect(trims.findAll('[data-pid]')).toHaveLength(0);
        // Schema defaults hydrate both settings for a module saved before they existed.
        expect(
            (settingBlock(wrapper, 'Ingest Offset').get('input').element as HTMLInputElement).value,
        ).toBe('0');
    });
});
