// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const mockCall = vi.fn();
vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ call: (...args: unknown[]) => mockCall(...args) }),
}));

import ModuleSettingsForm from './ModuleSettingsForm.vue';
import MrArrayField from '@/components/common/MrArrayField.vue';
import MrInput from '@/components/common/MrInput.vue';
import MrMultiSelect from '@/components/common/MrMultiSelect.vue';
import MrSelect from '@/components/common/MrSelect.vue';
import MrSlider from '@/components/common/MrSlider.vue';
import MrToggle from '@/components/common/MrToggle.vue';
import PidTrimField from '@/components/routing/widgets/PidTrimField.vue';
import { useEngineStore } from '@/stores/engines';
import type { FormField } from '@/composables/useModuleSettingsForm';

/** Video Player's fallback image, as its manifest declares it: restart-requiring. */
const IMAGE: FormField = {
    key: 'fallbackImagePath',
    type: 'string',
    label: 'Fallback Image',
    description: '',
    defaultValue: '',
    liveUpdatable: false,
    widget: 'imageUpload',
};
const UPLOADED = { path: '/uploads/video-player/slate.png', filename: 'slate.png' };

function mountForm(moduleId: string) {
    return mount(ModuleSettingsForm, {
        props: {
            fields: [IMAGE],
            settings: {},
            isVisible: () => true,
            isDisabled: () => false,
            getEnum: () => undefined,
            getMax: () => undefined,
            deviceOptions: () => [],
            engineId: 'eng-1',
            moduleId,
        },
    });
}

/** Picks a file in the upload's picker; the upload call stays open until `finish`. */
async function pickFile(form: ReturnType<typeof mountForm>): Promise<(result: unknown) => void> {
    let finish!: (result: unknown) => void;
    mockCall.mockImplementation((_path: string, method: string) =>
        method === 'upload'
            ? new Promise((resolve) => (finish = resolve))
            : Promise.resolve(undefined),
    );
    const input = form.get('input[type="file"]');
    const file = {
        name: 'slate.png',
        type: 'image/png',
        arrayBuffer: async () => new ArrayBuffer(4),
    };
    Object.defineProperty(input.element, 'files', { configurable: true, value: [file] });
    await input.trigger('change');
    await flushPromises();
    return finish;
}

describe('ModuleSettingsForm: an image upload belongs to the module it was made on (B-106)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockCall.mockReset();
        // jsdom has no object URLs; the form makes one for the preview.
        Object.assign(URL, { createObjectURL: () => 'blob:slate', revokeObjectURL: () => {} });
        useEngineStore().addEngine({
            engine_id: 'eng-1',
            display_name: 'Test Engine',
            modules: {
                'player-1': { pluginId: 'video-player', displayName: 'Player 1' },
                'player-2': { pluginId: 'video-player', displayName: 'Player 2' },
            },
        });
    });

    it('one that finishes with the panel still on its module goes into its settings', async () => {
        const form = mountForm('player-1');
        const finish = await pickFile(form);

        finish(UPLOADED);
        await flushPromises();

        expect(mockCall).toHaveBeenCalledWith(
            '/plugins/video-player',
            'upload',
            expect.objectContaining({ moduleId: 'player-1', filename: 'slate.png' }),
            expect.anything(),
        );
        expect(form.emitted('update')).toEqual([['fallbackImagePath', UPLOADED.path]]);
    });

    it('one that finishes after the panel moved to another module is not written into that one', async () => {
        const form = mountForm('player-1');
        const finish = await pickFile(form);

        await form.setProps({ moduleId: 'player-2' });
        finish(UPLOADED);
        await flushPromises();

        expect(form.emitted('update')).toBeUndefined();
    });
});

/** One field of every control kind the form renders, each greyed while `mode=locked`. */
function field(key: string, extra: Partial<FormField>): FormField {
    return {
        key,
        type: 'string',
        label: key,
        description: '',
        defaultValue: undefined,
        liveUpdatable: true,
        disabledWhen: 'mode=locked',
        disabledReason: `${key} is locked`,
        ...extra,
    };
}
const EVERY_CONTROL: FormField[] = [
    field('device', { deviceType: 'audio-input' }),
    field('choice', { enumValues: ['a', 'b'] }),
    field('langs', { type: 'array', optionsFrom: 'langs' }),
    field('rows', {
        type: 'array',
        items: { type: 'object', properties: { n: { type: 'number' } } },
    }),
    field('on', { type: 'boolean' }),
    field('gain', { type: 'number', widget: 'slider', minimum: 0, maximum: 100 }),
    field('slate', { widget: 'imageUpload' }),
    field('offset', { type: 'number' }),
    field('name', {}),
    field('trims', { type: 'object', widget: 'pidTrim', optionsFrom: 'pids' }),
];

function mountEveryControl(disabled: boolean) {
    return mount(ModuleSettingsForm, {
        props: {
            fields: EVERY_CONTROL,
            settings: {
                slate: '/uploads/video-player/slate.png',
                rows: [{ n: 1 }],
                trims: { '256': 5 },
            },
            isVisible: () => true,
            isDisabled: (f: FormField) => disabled && !!f.disabledWhen,
            getEnum: (f: FormField) => f.enumValues,
            getMax: (f: FormField) => f.maximum,
            deviceOptions: () => [{ value: 'hw:0', label: 'Card 0' }],
            engineId: 'eng-1',
            moduleId: 'player-1',
        },
    });
}

describe('ModuleSettingsForm: disabled with a reason (WI-P5-12)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockCall.mockReset().mockResolvedValue(undefined);
        Object.assign(URL, { createObjectURL: () => 'blob:slate', revokeObjectURL: () => {} });
        useEngineStore().addEngine({
            engine_id: 'eng-1',
            display_name: 'Test Engine',
            modules: {
                'player-1': {
                    pluginId: 'video-player',
                    displayName: 'Player 1',
                    fieldOptions: {
                        langs: [{ value: 'en', label: 'English' }],
                        pids: [{ value: '256', label: '0x0100 H.264 video' }],
                    },
                },
            },
        });
    });

    const controlsDisabled = (form: ReturnType<typeof mountEveryControl>) => [
        ...form.findAllComponents(MrSelect).map((w) => ['MrSelect', w.props('disabled')]),
        ...form.findAllComponents(MrMultiSelect).map((w) => ['MrMultiSelect', w.props('disabled')]),
        ...form.findAllComponents(MrArrayField).map((w) => ['MrArrayField', w.props('disabled')]),
        ...form.findAllComponents(MrToggle).map((w) => ['MrToggle', w.props('disabled')]),
        ...form.findAllComponents(MrSlider).map((w) => ['MrSlider', w.props('disabled')]),
        ...form.findAllComponents(MrInput).map((w) => ['MrInput', w.props('disabled')]),
        ['slate input', (form.get('input[type="file"]').element as HTMLInputElement).disabled],
        [
            'slate remove',
            (
                form.findAll('button').find((b) => b.text() === 'Remove')!
                    .element as HTMLButtonElement
            ).disabled,
        ],
        [
            'trims',
            (form.getComponent(PidTrimField).find('input').element as HTMLInputElement).disabled,
        ],
    ];

    it('every control is disabled while its x-disabledWhen holds, the reason shown once per field', () => {
        const form = mountEveryControl(true);

        const states = controlsDisabled(form);
        // Two MrSelects (device, choice), one MrInput each for offset and name.
        expect(states.length).toBeGreaterThanOrEqual(10);
        for (const [name, disabled] of states) expect([name, disabled]).toEqual([name, true]);
        const reasons = form.findAll('[data-test="disabled-reason"]').map((r) => r.text());
        expect(reasons).toEqual(EVERY_CONTROL.map((f) => `${f.key} is locked`));
    });

    it('and none is, with no reason, while it does not', () => {
        const form = mountEveryControl(false);

        for (const [name, disabled] of controlsDisabled(form)) {
            expect([name, !!disabled]).toEqual([name, false]);
        }
        expect(form.findAll('[data-test="disabled-reason"]')).toHaveLength(0);
    });
});
