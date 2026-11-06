// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

const mockConnectionField = vi.fn();
vi.mock('@/composables/usePatch', () => ({
    patch: { connectionField: (...args: unknown[]) => mockConnectionField(...args) },
}));

import ChannelMapEditor from './ChannelMapEditor.vue';
import { useEngineStore } from '@/stores/engines';

/** A transcoder's stereo 302M rendition into a 4-channel Audio Output (302M): the field's ENG
 *  into OUT1-4 (MR-053); `streamType` and `channelMap` vary. */
function seed(opts: { streamType?: string; channelMap?: unknown[]; outChannels?: number } = {}) {
    useEngineStore().addEngine({
        engine_id: 'eng-1',
        display_name: 'Test Engine',
        modules: {
            xc: {
                pluginId: 'audio-transcoder',
                displayName: 'ENG',
                settings: { channels: 1 },
                ports: [
                    {
                        id: 'out-0',
                        direction: 'output',
                        streamType: opts.streamType ?? 'audio/302m',
                        label: 'PCM',
                    },
                ],
            },
            out: {
                pluginId: 'audio-output-302m',
                displayName: 'OUT1-4',
                settings: { channels: opts.outChannels ?? 4 },
                ports: [
                    { id: 'audio-in', direction: 'input', streamType: 'audio/302m', label: 'In' },
                ],
            },
        },
        connections: [
            {
                id: 'conn-1',
                sourceModuleId: 'xc',
                sourcePortId: 'out-0',
                sinkModuleId: 'out',
                sinkPortId: 'audio-in',
                ...(opts.channelMap ? { channelMap: opts.channelMap } : {}),
            },
        ],
    });
}

const mountEditor = () =>
    mount(ChannelMapEditor, { props: { engineId: 'eng-1', connectionId: 'conn-1' } });

/** The mappings list as an operator reads it, one line per mapping. */
const rows = (w: ReturnType<typeof mountEditor>) =>
    w
        .findAll('.max-h-32 .flex.items-center')
        .map((r) => r.text().replace('→', ' → ').replace(/\s+/g, ' ').trim());

describe('ChannelMapEditor: a 302M connection with no map shows the default it plays (MR-053)', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mockConnectionField.mockReset();
    });

    it('a stereo source in a 4-channel output: channels 1 and 2, and 3 and 4 at −6 dB, marked default', async () => {
        seed();
        const w = mountEditor();
        await nextTick();
        expect(w.find('[data-testid="default-map"]').exists()).toBe(true);
        expect(rows(w)).toEqual([
            'CH 1 → CH 1',
            'CH 2 → CH 2',
            'CH 1 → CH 3 −6.0 dB',
            'CH 2 → CH 4 −6.0 dB',
        ]);
        expect(w.findAll('line[stroke-dasharray="6,4"]')).toHaveLength(4);
    });

    it('applied as it is, the connection keeps no map: the engine plays its default', async () => {
        seed();
        const w = mountEditor();
        await nextTick();
        await w
            .findAll('button')
            .find((b) => b.text() === 'Apply')!
            .trigger('click');
        expect(mockConnectionField).toHaveBeenCalledWith(
            'eng-1',
            'conn-1',
            'channelMap',
            undefined,
        );
    });

    it('an edit makes it a map of its own, saved as shown', async () => {
        seed();
        const w = mountEditor();
        await nextTick();
        // Click the CH 1 → CH 3 line away, then CH 2 → CH 4.
        await w.findAll('line')[2].trigger('click');
        await w.findAll('line')[2].trigger('click');
        expect(w.find('[data-testid="default-map"]').exists()).toBe(false);
        await w
            .findAll('button')
            .find((b) => b.text() === 'Apply')!
            .trigger('click');
        expect(mockConnectionField).toHaveBeenCalledWith('eng-1', 'conn-1', 'channelMap', [
            { srcChannel: 0, dstChannel: 0 },
            { srcChannel: 1, dstChannel: 1 },
        ]);
    });

    it('a stereo source in a mono output: both channels at −6 dB', async () => {
        seed({ outChannels: 1 });
        const w = mountEditor();
        await nextTick();
        expect(rows(w)).toEqual(['CH 1 → CH 1 −6.0 dB', 'CH 2 → CH 1 −6.0 dB']);
    });

    it('a map that is set is shown as it is, not marked default', async () => {
        seed({ channelMap: [{ srcChannel: 0, dstChannel: 1 }] });
        const w = mountEditor();
        await nextTick();
        expect(w.find('[data-testid="default-map"]').exists()).toBe(false);
        expect(rows(w)).toEqual(['CH 1 → CH 2']);
    });

    it('a PipeWire (pcm) connection keeps its own starting map, unmarked', async () => {
        seed({ streamType: 'audio/pcm' });
        const w = mountEditor();
        await nextTick();
        expect(w.find('[data-testid="default-map"]').exists()).toBe(false);
        // Mono (`channels: 1`) into four: the old fan-out guess.
        expect(rows(w)).toEqual(['CH 1 → CH 1', 'CH 1 → CH 2', 'CH 1 → CH 3', 'CH 1 → CH 4']);
    });
});
