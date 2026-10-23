// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

const mockCall = vi.fn();
vi.mock('@/stores/socket', () => ({
    useSocketStore: () => ({ call: (...args: unknown[]) => mockCall(...args) }),
}));

import ModuleSettingsForm from './ModuleSettingsForm.vue';
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
