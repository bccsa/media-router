// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

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
import MrHelpTip from '@/components/common/MrHelpTip.vue';
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

const COOLDOWN_HELP =
    "Adds latency only when this input's stream is bursty (packets arriving in bursts, as through some relays). The input then runs at its bursts' height and comes back down no sooner than this long after the last burst, instead of skipping and re-syncing after every burst. A steady stream gets no added latency. Set it longer than the time between bursts; 0 turns smoothing off.";

/** srt-input's schema with the ingest timing settings as WI-P1-9 and b95s inject them. */
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
        smoothingCooldownMin: {
            type: 'number',
            default: 5,
            minimum: 0,
            maximum: 60,
            'x-unit': 'min',
            'x-live': true,
            title: 'Smoothing Cooldown',
            description: COOLDOWN_HELP,
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
                liveUpdatableParams: [
                    'playoutOffsetMs',
                    'ingestOffsetMs',
                    'pidTrimsMs',
                    'smoothingCooldownMin',
                ],
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

// Looked up afresh each time, so a replaced element cannot pass for the box on screen.
const offsetBox = (wrapper: VueWrapper) => settingBlock(wrapper, 'Ingest Offset').get('input');
const cooldownBox = (wrapper: VueWrapper) =>
    settingBlock(wrapper, 'Smoothing Cooldown').get('input');
const trimBox = (wrapper: VueWrapper, pid: string) =>
    settingBlock(wrapper, 'Per-PID Trim').get(`[data-pid="${pid}"] input`);

/** Types `text` one keystroke at a time, an input event each, as an operator would. */
async function typeKeys(
    input: Pick<DOMWrapper<Element>, 'element' | 'trigger'>,
    text: string,
): Promise<void> {
    for (let i = 1; i <= text.length; i++) {
        (input.element as HTMLInputElement).value = text.slice(0, i);
        await input.trigger('input');
    }
}

/** What a number box holds after text it cannot parse ("-", "1e"): '' with badInput set. */
function enterUnparseable(el: HTMLInputElement): void {
    el.value = '';
    Object.defineProperty(el, 'validity', { configurable: true, value: { badInput: true } });
}

describe('ModuleSettingsPanel — srt-input ingest timing settings', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockModuleSetting.mockReset();
        mockModuleSettings.mockReset();
    });
    afterEach(() => {
        vi.useRealTimers();
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

    it('typing "1500" into Ingest Offset writes once, on change, not per keystroke', async () => {
        vi.useFakeTimers();
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');
        const input = settingBlock(wrapper, 'Ingest Offset').get('input');

        await typeKeys(input, '1500');
        vi.advanceTimersByTime(1000);
        expect(mockModuleSetting).not.toHaveBeenCalled();

        await input.trigger('change');
        // Past the live-update throttle, so a trailing write would show here too.
        vi.advanceTimersByTime(1000);
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'ingestOffsetMs', 1500],
        ]);
    });

    it('typing "1500" into a trim writes the map once, on change', async () => {
        vi.useFakeTimers();
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');
        const input = settingBlock(wrapper, 'Per-PID Trim').get('[data-pid="256"] input');

        await typeKeys(input, '1500');
        await input.trigger('change');
        vi.advanceTimersByTime(1000);

        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'pidTrimsMs', { '256': 1500, '257': 120, '300': 15 }],
        ]);
    });

    // Each re-renders the form; Vue then resets a bound box's text to the bound value.
    it.each<[string, () => void]>([
        [
            'an info patch on its engine',
            () => useEngineStore().patchInfo('eng-1', { online: true }),
        ],
        [
            'a structural patch on another engine',
            () =>
                useEngineStore().applyEnginePatch('eng-2', [
                    { op: 'add', path: '/connections/-', value: { id: 'c1', from: 'a', to: 'b' } },
                ]),
        ],
        [
            'an echo of another setting of the module',
            () =>
                useEngineStore().applyEnginePatch('eng-1', [
                    { op: 'replace', path: '/modules/srt-input-1/settings/mode', value: 'caller' },
                ]),
        ],
    ])('uncommitted Ingest Offset text survives %s', async (_, storeUpdate) => {
        seedSrtInput();
        useEngineStore().addEngine({ engine_id: 'eng-2', display_name: 'Other', modules: {} });
        const wrapper = mountPanel('srt-input-1');

        await typeKeys(offsetBox(wrapper), '15');
        storeUpdate();
        await nextTick();

        expect(offsetBox(wrapper).element.value).toBe('15');
        expect(mockModuleSetting).not.toHaveBeenCalled();
        await offsetBox(wrapper).trigger('change');
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'ingestOffsetMs', 15],
        ]);
    });

    it('an Ingest Offset typed back to its stored text and left follows the store', async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        // Back at the text it had on focus, so leaving the box fires blur but no change.
        await typeKeys(offsetBox(wrapper), '15');
        await typeKeys(offsetBox(wrapper), '-40');
        await offsetBox(wrapper).trigger('blur');
        useEngineStore().applyEnginePatch('eng-1', [
            { op: 'replace', path: '/modules/srt-input-1/settings/ingestOffsetMs', value: -20 },
        ]);
        await nextTick();

        expect(offsetBox(wrapper).element.value).toBe('-20');
        expect(mockModuleSetting).not.toHaveBeenCalled();
    });

    it('uncommitted Ingest Offset text outlasts a switch to another window or tab', async () => {
        seedSrtInput();
        const wrapper = mount(ModuleSettingsPanel, {
            props: { engineId: 'eng-1', moduleId: 'srt-input-1' },
            attachTo: document.body,
        });
        offsetBox(wrapper).element.focus();

        await typeKeys(offsetBox(wrapper), '15');
        // The window losing focus blurs the box, which stays document.activeElement.
        await offsetBox(wrapper).trigger('blur');
        useEngineStore().patchInfo('eng-1', { online: true });
        await nextTick();

        expect(document.activeElement).toBe(offsetBox(wrapper).element);
        expect(offsetBox(wrapper).element.value).toBe('15');
        expect(mockModuleSetting).not.toHaveBeenCalled();
        wrapper.unmount();
    });

    it('uncommitted Ingest Offset text never shows in the next module opened', async () => {
        seedSrtInput();
        useEngineStore().applyEnginePatch('eng-1', [
            {
                op: 'add',
                path: '/modules/srt-input-2',
                value: {
                    pluginId: 'srt-input',
                    configSchema: SRT_INPUT_SCHEMA,
                    settings: { ingestOffsetMs: 25 },
                },
            },
        ]);
        const wrapper = mountPanel('srt-input-1');

        await typeKeys(offsetBox(wrapper), '15');
        // Removed by another operator: the box goes away with no blur, so nothing commits.
        useEngineStore().applyEnginePatch('eng-1', [
            { op: 'remove', path: '/modules/srt-input-1' },
        ]);
        await nextTick();
        expect(wrapper.text()).toContain('No configurable settings.');
        await wrapper.setProps({ moduleId: 'srt-input-2' });

        expect(offsetBox(wrapper).element.value).toBe('25');
        expect(mockModuleSetting).not.toHaveBeenCalled();
    });

    it("uncommitted trim text survives an echo of another PID's trim", async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await typeKeys(trimBox(wrapper, '256'), '15');
        useEngineStore().applyEnginePatch('eng-1', [
            {
                op: 'replace',
                path: '/modules/srt-input-1/settings/pidTrimsMs',
                value: { '257': 130, '300': 15 },
            },
        ]);
        await nextTick();

        expect((trimBox(wrapper, '256').element as HTMLInputElement).value).toBe('15');
        expect((trimBox(wrapper, '257').element as HTMLInputElement).value).toBe('130');
        await trimBox(wrapper, '256').trigger('change');
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'pidTrimsMs', { '256': 15, '257': 130, '300': 15 }],
        ]);
    });

    it('clamps the Ingest Offset to ±10,000 ms when it commits', async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');
        const input = settingBlock(wrapper, 'Ingest Offset').get('input');

        await input.setValue('-25000');

        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'ingestOffsetMs', -10000],
        ]);
        expect((input.element as HTMLInputElement).value).toBe('-10000');
    });

    it('Ingest Offset text the browser cannot parse keeps the last good value', async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');
        const input = settingBlock(wrapper, 'Ingest Offset').get('input');
        const el = input.element as HTMLInputElement;

        enterUnparseable(el);
        await input.trigger('change');
        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(el.value).toBe('-40');

        // A cleared box, without badInput, commits 0, the default.
        Reflect.deleteProperty(el, 'validity');
        el.value = '';
        await input.trigger('change');
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'ingestOffsetMs', 0],
        ]);
    });

    it('a stored Ingest Offset that is not a number counts as 0, the default', async () => {
        // O alone, as on a capture (OQ-15), so no trim widget is handed the bad value too.
        seedSrtInput({
            configSchema: {
                properties: { ingestOffsetMs: SRT_INPUT_SCHEMA.properties.ingestOffsetMs },
            },
            settings: { ingestOffsetMs: 'x' },
        });
        const wrapper = mountPanel('srt-input-1');
        const input = settingBlock(wrapper, 'Ingest Offset').get('input');
        const el = input.element as HTMLInputElement;

        enterUnparseable(el);
        await input.trigger('change');

        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(el.value).toBe('0');
    });

    it("renders Smoothing Cooldown as a live number in min, 0-60, its help the owner's text", () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        const block = settingBlock(wrapper, 'Smoothing Cooldown');
        const input = block.get('input[type="number"]').element as HTMLInputElement;
        // Not saved yet: the schema default hydrates it.
        expect(input.value).toBe('5');
        expect(input.min).toBe('0');
        expect(input.max).toBe('60');
        expect(block.get('[data-test="unit"]').text()).toBe('min');
        const tips = block
            .findAllComponents(MrHelpTip)
            .map((t: { props(name: string): unknown }) => t.props('text'));
        expect(tips).toEqual([
            'Live update — changes apply instantly without restarting the module',
            COOLDOWN_HELP,
        ]);
    });

    it('typing "10" into Smoothing Cooldown writes once, on change, never the 1 on the way', async () => {
        vi.useFakeTimers();
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        // Cleared first, as an operator does: an emitted 0 would turn smoothing off.
        (cooldownBox(wrapper).element as HTMLInputElement).value = '';
        await cooldownBox(wrapper).trigger('input');
        await typeKeys(cooldownBox(wrapper), '10');
        vi.advanceTimersByTime(1000);
        expect(mockModuleSetting).not.toHaveBeenCalled();

        await cooldownBox(wrapper).trigger('change');
        vi.advanceTimersByTime(1000);
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'smoothingCooldownMin', 10],
        ]);
    });

    it('clamps the Smoothing Cooldown to 0-60 min when it commits', async () => {
        vi.useFakeTimers();
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await cooldownBox(wrapper).setValue('90');
        await cooldownBox(wrapper).setValue('-3');
        // Past the live-update throttle, which holds the second write back.
        vi.advanceTimersByTime(1000);

        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'smoothingCooldownMin', 60],
            ['eng-1', 'srt-input-1', 'smoothingCooldownMin', 0],
        ]);
    });

    it('a stored Smoothing Cooldown that is not a number counts as 5, the default', async () => {
        seedSrtInput({
            configSchema: {
                properties: {
                    smoothingCooldownMin: SRT_INPUT_SCHEMA.properties.smoothingCooldownMin,
                },
            },
            settings: { smoothingCooldownMin: 'x' },
        });
        const wrapper = mountPanel('srt-input-1');
        const el = cooldownBox(wrapper).element as HTMLInputElement;

        enterUnparseable(el);
        await cooldownBox(wrapper).trigger('change');

        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(el.value).toBe('5');
    });

    it('shows the unit beside the change-only boxes, not beside a plain number field', () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        expect(settingBlock(wrapper, 'Ingest Offset').get('[data-test="unit"]').text()).toBe('ms');
        expect(settingBlock(wrapper, 'Smoothing Cooldown').get('[data-test="unit"]').text()).toBe(
            'min',
        );
        // Playout Offset declares x-unit ms as well and keeps the bare MrInput.
        const playout = settingBlock(wrapper, 'Playout Offset');
        expect(playout.find('[data-test="unit"]').exists()).toBe(false);
        expect(playout.text()).not.toContain('ms');
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
                smoothingCooldownMin: 5,
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
