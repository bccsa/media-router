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

/** Why a setting's last entry was refused, as its block shows it (B-104). */
function reasonIn(wrapper: VueWrapper, title: string): string | undefined {
    const reason = settingBlock(wrapper, title).find('[data-test="reason"]');
    return reason.exists() ? reason.text() : undefined;
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

    it("refuses a trim past the schema's per-PID bound, with the reason, and writes nothing", async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await settingBlock(wrapper, 'Per-PID Trim').get('[data-pid="257"] input').setValue('2500');

        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(settingBlock(wrapper, 'Per-PID Trim').get('[data-reason-pid="257"]').text()).toBe(
            'Must be between -2000 and 2000 ms',
        );
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

    it('refuses an Ingest Offset past ±10,000 ms: nothing written, the text kept, the reason shown', async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await offsetBox(wrapper).setValue('-25000');

        // Never written as the nearest bound: a live -10000 would be a gap or a drop on the stream.
        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect((offsetBox(wrapper).element as HTMLInputElement).value).toBe('-25000');
        expect(reasonIn(wrapper, 'Ingest Offset')).toBe('Must be between -10000 and 10000 ms');
    });

    it('Ingest Offset text the browser cannot parse, or a cleared box, writes nothing and says why', async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');
        const input = settingBlock(wrapper, 'Ingest Offset').get('input');
        const el = input.element as HTMLInputElement;

        enterUnparseable(el);
        await input.trigger('change');
        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(reasonIn(wrapper, 'Ingest Offset')).toBe('Enter a number');

        // A cleared box, without badInput, is refused too: 0 is typed, never assumed.
        Reflect.deleteProperty(el, 'validity');
        await input.setValue('');
        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(reasonIn(wrapper, 'Ingest Offset')).toBe('Enter a number');
    });

    it('a stored Ingest Offset that is not a number takes the next number entered', async () => {
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

        // 0 differs from what is stored, so it is written.
        Reflect.deleteProperty(el, 'validity');
        await input.setValue('0');
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'ingestOffsetMs', 0],
        ]);
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

    it('refuses a Smoothing Cooldown outside 0-60 min, and a cleared box, with the reason', async () => {
        vi.useFakeTimers();
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await cooldownBox(wrapper).setValue('90');
        expect(reasonIn(wrapper, 'Smoothing Cooldown')).toBe('Must be between 0 and 60 min');
        await cooldownBox(wrapper).setValue('-3');
        expect(reasonIn(wrapper, 'Smoothing Cooldown')).toBe('Must be between 0 and 60 min');
        // Read as 0, a cleared box would have turned smoothing off.
        await cooldownBox(wrapper).setValue('');
        expect(reasonIn(wrapper, 'Smoothing Cooldown')).toBe('Enter a number');
        // Past the live-update throttle, so a held-back write would show here too.
        vi.advanceTimersByTime(1000);

        expect(mockModuleSetting).not.toHaveBeenCalled();
    });

    it('a stored Smoothing Cooldown that is not a number takes the next number entered', async () => {
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
        expect(reasonIn(wrapper, 'Smoothing Cooldown')).toBe('Enter a number');

        Reflect.deleteProperty(el, 'validity');
        await cooldownBox(wrapper).setValue('5');
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'srt-input-1', 'smoothingCooldownMin', 5],
        ]);
    });

    it('shows the unit beside Ingest Offset and Smoothing Cooldown, not beside a plain number field', () => {
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

/** A module with each kind of typed setting B-104 covers, live and restart-requiring. */
const TYPED_SCHEMA = {
    type: 'object',
    properties: {
        host: { type: 'string', default: '0.0.0.0', title: 'Host' },
        port: { type: 'number', default: 9000, minimum: 1, maximum: 65535, title: 'Port' },
        busBatchMs: { type: 'integer', default: 20, minimum: 0, maximum: 100, title: 'Bus Batch' },
        playoutOffsetMs: {
            type: 'number',
            minimum: 0,
            maximum: 10000,
            'x-unit': 'ms',
            'x-live': true,
            title: 'Playout Offset',
        },
        url: { type: 'string', default: '', 'x-live': true, 'x-debounceMs': 800, title: 'URL' },
        volume: {
            type: 'number',
            default: 100,
            minimum: 0,
            maximum: 150,
            'x-widget': 'slider',
            'x-maxFrom': 'volumeMax',
            'x-unit': '%',
            'x-live': true,
            title: 'Volume',
        },
        volumeMax: { type: 'number', enum: [100, 150, 500], default: 150, title: 'Range' },
        mode: { type: 'string', enum: ['listener', 'caller'], default: 'listener', title: 'Mode' },
        fec: { type: 'boolean', default: false, title: 'FEC' },
    },
};

/** One engine holding a module per entry, each with these settings over the defaults. */
function seedTyped(modules: Record<string, Record<string, unknown>> = { 'typed-1': {} }) {
    useEngineStore().addEngine({
        engine_id: 'eng-1',
        display_name: 'Test Engine',
        modules: Object.fromEntries(
            Object.entries(modules).map(([id, settings]) => [
                id,
                {
                    pluginId: 'srt-input',
                    displayName: id,
                    configSchema: TYPED_SCHEMA,
                    liveUpdatableParams: ['playoutOffsetMs', 'url', 'volume'],
                    settings: { playoutOffsetMs: 120, ...settings },
                },
            ]),
        ),
    });
}

const boxIn = (wrapper: VueWrapper, title: string) =>
    settingBlock(wrapper, title).get('input[type="number"], input[type="text"]');

async function save(wrapper: VueWrapper): Promise<void> {
    await wrapper
        .findAll('button')
        .find((b) => b.text() === 'Save')!
        .trigger('click');
}

describe('ModuleSettingsPanel — every typed setting validates and writes at Enter or on leaving it (B-104)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockModuleSetting.mockReset();
        mockModuleSettings.mockReset();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('a live number writes nothing and shows no reason while typed, then once at the commit', async () => {
        vi.useFakeTimers();
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await typeKeys(boxIn(wrapper, 'Playout Offset'), '250');
        vi.advanceTimersByTime(1000);
        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(reasonIn(wrapper, 'Playout Offset')).toBeUndefined();

        await boxIn(wrapper, 'Playout Offset').trigger('change');
        vi.advanceTimersByTime(1000);
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'typed-1', 'playoutOffsetMs', 250],
        ]);
    });

    it('a live number out of range is refused with the reason; an unchanged commit writes nothing', async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await boxIn(wrapper, 'Playout Offset').setValue('20000');
        expect(reasonIn(wrapper, 'Playout Offset')).toBe('Must be between 0 and 10000 ms');
        await boxIn(wrapper, 'Playout Offset').setValue('120');
        expect(reasonIn(wrapper, 'Playout Offset')).toBeUndefined();

        expect(mockModuleSetting).not.toHaveBeenCalled();
    });

    it("a restart-requiring number reaches the panel's copy once, at the commit, and Save writes it", async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        // Typed but not committed: Save still writes the stored port.
        await typeKeys(boxIn(wrapper, 'Port'), '9001');
        await save(wrapper);
        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ port: 9000 })],
        ]);

        mockModuleSettings.mockReset();
        await boxIn(wrapper, 'Port').trigger('change');
        // Not live: no write of its own (the engine would hold it pending a restart).
        expect(mockModuleSetting).not.toHaveBeenCalled();
        await save(wrapper);
        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ port: 9001 })],
        ]);
    });

    it('a restart-requiring number out of range is refused, and Save keeps the stored value', async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await boxIn(wrapper, 'Port').setValue('70000');
        expect(reasonIn(wrapper, 'Port')).toBe('Must be between 1 and 65535');
        expect((boxIn(wrapper, 'Port').element as HTMLInputElement).value).toBe('70000');
        await save(wrapper);

        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ port: 9000 })],
        ]);
    });

    it('a live text setting writes nothing while typed and once at the commit, after its debounce', async () => {
        vi.useFakeTimers();
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await typeKeys(boxIn(wrapper, 'URL'), 'http://feed/a.m3u8');
        vi.advanceTimersByTime(2000);
        expect(mockModuleSetting).not.toHaveBeenCalled();

        await boxIn(wrapper, 'URL').trigger('change');
        vi.advanceTimersByTime(800);
        expect(mockModuleSetting.mock.calls).toEqual([
            ['eng-1', 'typed-1', 'url', 'http://feed/a.m3u8'],
        ]);
    });

    it('a restart-requiring text setting commits once into the copy Save writes', async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await typeKeys(boxIn(wrapper, 'Host'), '192.0.2.5');
        await boxIn(wrapper, 'Host').trigger('change');
        await save(wrapper);

        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ host: '192.0.2.5' })],
        ]);
    });

    it('an integer setting is a number box that takes whole numbers only', async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');
        const box = () => boxIn(wrapper, 'Bus Batch');

        expect(box().attributes('type')).toBe('number');
        await box().setValue('2.5');
        expect(reasonIn(wrapper, 'Bus Batch')).toBe('Enter a whole number');
        await box().setValue('40');
        await save(wrapper);

        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ busBatchMs: 40 })],
        ]);
    });

    it("a slider's typed box takes the maximum from x-maxFrom: 300 % in a range of 500, not of 150", async () => {
        seedTyped({ 'typed-1': { volumeMax: 500 }, 'typed-2': { volumeMax: 150 } });
        const wide = mountPanel('typed-1');
        const narrow = mountPanel('typed-2');
        const sliderBox = (w: VueWrapper) => settingBlock(w, 'Volume').get('input[type="number"]');

        expect(sliderBox(wide).attributes('max')).toBe('500');
        await sliderBox(wide).setValue('300');
        await sliderBox(narrow).setValue('300');

        expect(mockModuleSetting.mock.calls).toEqual([['eng-1', 'typed-1', 'volume', 300]]);
        expect(reasonIn(narrow, 'Volume')).toBe('Must be between 0 and 150 %');
    });

    it('typed text in a plain number and a text field survives a re-render of the form', async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await typeKeys(boxIn(wrapper, 'Playout Offset'), '33');
        await typeKeys(boxIn(wrapper, 'Host'), 'gate');
        useEngineStore().applyEnginePatch('eng-1', [
            { op: 'replace', path: '/modules/typed-1/settings/volume', value: 80 },
        ]);
        await nextTick();

        expect((boxIn(wrapper, 'Playout Offset').element as HTMLInputElement).value).toBe('33');
        expect((boxIn(wrapper, 'Host').element as HTMLInputElement).value).toBe('gate');
        expect(mockModuleSetting).not.toHaveBeenCalled();
    });

    it('typed text stays with its module when the panel opens another one', async () => {
        seedTyped({ 'typed-1': {}, 'typed-2': { playoutOffsetMs: 60 } });
        const wrapper = mountPanel('typed-1');

        await typeKeys(boxIn(wrapper, 'Playout Offset'), '777');
        await wrapper.setProps({ moduleId: 'typed-2' });

        expect((boxIn(wrapper, 'Playout Offset').element as HTMLInputElement).value).toBe('60');
        expect(mockModuleSetting).not.toHaveBeenCalled();
    });
});

/** Picks `label` in a setting's dropdown, as an operator would. */
async function choose(wrapper: VueWrapper, title: string, label: string): Promise<void> {
    await settingBlock(wrapper, title).get('button').trigger('click');
    const option = settingBlock(wrapper, title)
        .findAll('div')
        .find((d) => d.text() === label);
    if (!option) throw new Error(`no "${label}" in "${title}"`);
    await option.trigger('click');
}

const shownIn = (wrapper: VueWrapper, title: string) =>
    settingBlock(wrapper, title).get('button').text();
const toggleIn = (wrapper: VueWrapper, title: string) =>
    settingBlock(wrapper, title).get('[role="switch"]').attributes('aria-checked');

/** Another operator's write, as the tree mirror applies it to the store. */
async function outsideWrite(moduleId: string, key: string, value: unknown): Promise<void> {
    useEngineStore().applyEnginePatch('eng-1', [
        { op: 'replace', path: `/modules/${moduleId}/settings/${key}`, value },
    ]);
    await nextTick();
}

/** Port 9001 typed and committed, Mode set to caller and FEC on: three restart-requiring edits. */
async function commitThree(wrapper: VueWrapper): Promise<void> {
    await boxIn(wrapper, 'Port').setValue('9001');
    await choose(wrapper, 'Mode', 'caller');
    await settingBlock(wrapper, 'FEC').get('[role="switch"]').trigger('click');
}

function expectThreeKept(wrapper: VueWrapper): void {
    expect((boxIn(wrapper, 'Port').element as HTMLInputElement).value).toBe('9001');
    expect(shownIn(wrapper, 'Mode')).toBe('caller');
    expect(toggleIn(wrapper, 'FEC')).toBe('true');
}

describe('ModuleSettingsPanel — a setting changed but not saved survives another write to its module (B-105)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockModuleSetting.mockReset();
        mockModuleSettings.mockReset();
        // As usePatch does: the store first (optimistic), then the write.
        mockModuleSetting.mockImplementation(
            (engineId: string, moduleId: string, key: string, value: unknown) =>
                useEngineStore().applyEnginePatch(engineId, [
                    { op: 'replace', path: `/modules/${moduleId}/settings/${key}`, value },
                ]),
        );
        mockModuleSettings.mockImplementation(
            (engineId: string, moduleId: string, changes: Record<string, unknown>) =>
                useEngineStore().applyEnginePatch(
                    engineId,
                    Object.entries(changes).map(([key, value]) => ({
                        op: 'replace',
                        path: `/modules/${moduleId}/settings/${key}`,
                        value,
                    })),
                ),
        );
    });

    it('a live slider moved in the panel keeps a committed number, choice and toggle; Save writes them with the volume', async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await commitThree(wrapper);
        await settingBlock(wrapper, 'Volume').get('input[type="range"]').setValue('80');
        await nextTick();

        expect(mockModuleSetting.mock.calls).toEqual([['eng-1', 'typed-1', 'volume', 80]]);
        expectThreeKept(wrapper);
        await save(wrapper);
        expect(mockModuleSettings.mock.calls).toEqual([
            [
                'eng-1',
                'typed-1',
                expect.objectContaining({ port: 9001, mode: 'caller', fec: true, volume: 80 }),
            ],
        ]);
    });

    it("another operator's write keeps them too; the key it wrote follows it, and Save writes both", async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await commitThree(wrapper);
        await outsideWrite('typed-1', 'playoutOffsetMs', 300);

        expectThreeKept(wrapper);
        expect((boxIn(wrapper, 'Playout Offset').element as HTMLInputElement).value).toBe('300');
        await save(wrapper);
        expect(mockModuleSettings.mock.calls).toEqual([
            [
                'eng-1',
                'typed-1',
                expect.objectContaining({
                    port: 9001,
                    mode: 'caller',
                    fec: true,
                    playoutOffsetMs: 300,
                }),
            ],
        ]);
    });

    it("a key changed in the panel and by another operator keeps the panel's value, which Save writes", async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await boxIn(wrapper, 'Port').setValue('9001');
        await outsideWrite('typed-1', 'port', 9100);
        await outsideWrite('typed-1', 'port', 9200);

        expect((boxIn(wrapper, 'Port').element as HTMLInputElement).value).toBe('9001');
        await save(wrapper);
        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ port: 9001 })],
        ]);
    });

    it('once saved, a key is in step again and follows the next write from outside', async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await boxIn(wrapper, 'Port').setValue('9001');
        await save(wrapper);
        // The manager refuses it, say: the tree puts the stored value back.
        await outsideWrite('typed-1', 'port', 9000);

        expect((boxIn(wrapper, 'Port').element as HTMLInputElement).value).toBe('9000');
    });

    it("a map changed in place from outside (a PID's trim) reaches the panel beside a committed Latency", async () => {
        seedSrtInput();
        const wrapper = mountPanel('srt-input-1');

        await settingBlock(wrapper, 'Latency').get('input').setValue('400');
        useEngineStore().applyEnginePatch('eng-1', [
            { op: 'replace', path: '/modules/srt-input-1/settings/pidTrimsMs/257', value: 60 },
        ]);
        await nextTick();

        expect(shiftOf(settingBlock(wrapper, 'Per-PID Trim'), '257')).toBe('20');
        expect(
            (settingBlock(wrapper, 'Latency').get('input').element as HTMLInputElement).value,
        ).toBe('400');
        await save(wrapper);
        expect(mockModuleSettings.mock.calls).toEqual([
            [
                'eng-1',
                'srt-input-1',
                expect.objectContaining({ latency: 400, pidTrimsMs: { '257': 60, '300': 15 } }),
            ],
        ]);
    });

    it('typing not yet committed survives a write from outside to its own key, then commits over it', async () => {
        seedTyped();
        const wrapper = mountPanel('typed-1');

        await typeKeys(boxIn(wrapper, 'Port'), '9001');
        await outsideWrite('typed-1', 'port', 9100);
        await outsideWrite('typed-1', 'playoutOffsetMs', 300);
        expect((boxIn(wrapper, 'Port').element as HTMLInputElement).value).toBe('9001');

        await boxIn(wrapper, 'Port').trigger('change');
        await save(wrapper);
        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ port: 9001, playoutOffsetMs: 300 })],
        ]);
    });

    it('another module in the panel starts from its own stored settings, and coming back drops the edit, as before', async () => {
        seedTyped({ 'typed-1': {}, 'typed-2': { port: 7000 } });
        const wrapper = mountPanel('typed-1');

        await commitThree(wrapper);
        await wrapper.setProps({ moduleId: 'typed-2' });
        expect((boxIn(wrapper, 'Port').element as HTMLInputElement).value).toBe('7000');
        expect(shownIn(wrapper, 'Mode')).toBe('listener');
        expect(toggleIn(wrapper, 'FEC')).toBe('false');

        await wrapper.setProps({ moduleId: 'typed-1' });
        expect((boxIn(wrapper, 'Port').element as HTMLInputElement).value).toBe('9000');
        await save(wrapper);
        expect(mockModuleSettings.mock.calls).toEqual([
            [
                'eng-1',
                'typed-1',
                expect.objectContaining({ port: 9000, mode: 'listener', fec: false }),
            ],
        ]);
    });
});

describe('ModuleSettingsPanel — a maximum set by another setting (B-103)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockModuleSetting.mockReset();
        mockModuleSettings.mockReset();
    });

    const sliderBox = (w: VueWrapper) => settingBlock(w, 'Volume').get('input[type="number"]');

    it('lowering Volume Range brings the volume down to it in the one write Save makes', async () => {
        seedTyped({ 'typed-1': { volumeMax: 500, volume: 300 } });
        const wrapper = mountPanel('typed-1');

        await choose(wrapper, 'Range', '150');
        expect(sliderBox(wrapper).attributes('max')).toBe('150');
        expect((sliderBox(wrapper).element as HTMLInputElement).value).toBe('150');
        // Not live on its own: the volume is written with the range, not before it.
        expect(mockModuleSetting).not.toHaveBeenCalled();
        await save(wrapper);

        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ volumeMax: 150, volume: 150 })],
        ]);
    });

    it('raising Volume Range moves no volume', async () => {
        seedTyped({ 'typed-1': { volumeMax: 150, volume: 120 } });
        const wrapper = mountPanel('typed-1');

        await choose(wrapper, 'Range', '500');
        expect(sliderBox(wrapper).attributes('max')).toBe('500');
        await save(wrapper);

        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ volumeMax: 500, volume: 120 })],
        ]);
    });

    it('a change of another setting moves no volume, even one above its range (the engine brings it down at a start)', async () => {
        seedTyped({ 'typed-1': { volumeMax: 150, volume: 300 } });
        const wrapper = mountPanel('typed-1');

        await settingBlock(wrapper, 'FEC').get('[role="switch"]').trigger('click');
        await save(wrapper);

        expect(mockModuleSettings.mock.calls).toEqual([
            [
                'eng-1',
                'typed-1',
                expect.objectContaining({ fec: true, volumeMax: 150, volume: 300 }),
            ],
        ]);
    });

    it('a volume raised from outside over a range lowered in the panel stays within that range', async () => {
        seedTyped({ 'typed-1': { volumeMax: 500, volume: 100 } });
        const wrapper = mountPanel('typed-1');

        await choose(wrapper, 'Range', '150');
        await outsideWrite('typed-1', 'volume', 400);
        expect((sliderBox(wrapper).element as HTMLInputElement).value).toBe('150');
        await save(wrapper);

        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'typed-1', expect.objectContaining({ volumeMax: 150, volume: 150 })],
        ]);
    });

    it("x-maxBy through the same rule: AAC caps Audio Encoder's bitrate at 320, pulled down with the codec", async () => {
        useEngineStore().addEngine({
            engine_id: 'eng-1',
            display_name: 'Test Engine',
            modules: {
                enc: {
                    pluginId: 'audio-encoder',
                    configSchema: {
                        type: 'object',
                        properties: {
                            codec: {
                                type: 'string',
                                enum: ['opus', 'aac'],
                                default: 'opus',
                                title: 'Codec',
                            },
                            bitrate: {
                                type: 'number',
                                minimum: 6,
                                maximum: 510,
                                default: 128,
                                title: 'Bitrate',
                                'x-maxBy': { field: 'codec', map: { opus: 510, aac: 320 } },
                            },
                        },
                    },
                    liveUpdatableParams: ['bitrate'],
                    settings: { codec: 'opus', bitrate: 400 },
                },
            },
        });
        const wrapper = mountPanel('enc');

        expect(boxIn(wrapper, 'Bitrate').attributes('max')).toBe('510');
        await choose(wrapper, 'Codec', 'aac');
        expect(boxIn(wrapper, 'Bitrate').attributes('max')).toBe('320');
        await save(wrapper);

        expect(mockModuleSetting).not.toHaveBeenCalled();
        expect(mockModuleSettings.mock.calls).toEqual([
            ['eng-1', 'enc', expect.objectContaining({ codec: 'aac', bitrate: 320 })],
        ]);
    });
});
