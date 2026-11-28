// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import XrefSettingsPanel from './XrefSettingsPanel.vue';
import type { RefLink, RefNode } from '@/utils/crossRefTypes';

function link(over: Partial<RefLink> = {}): RefLink {
    return {
        connectionId: 'c1',
        outKey: 'out:enc:ts',
        inKey: 'in:srt:ts',
        sourceModuleId: 'enc',
        sourcePortId: 'ts',
        sinkModuleId: 'srt',
        sinkPortId: 'ts',
        sourcePage: 'pg-a',
        sinkPage: 'pg-b',
        tagged: false,
        readOnly: false,
        ...over,
    };
}

function tag(over: Partial<RefNode> = {}): RefNode {
    return {
        key: 'out:enc:ts',
        kind: 'out',
        moduleId: 'enc',
        portId: 'ts',
        page: 'pg-a',
        streamType: 'muxed/mpegts',
        color: '#f59e0b',
        readOnly: false,
        n: 7,
        label: '#7',
        hint: '→ Studio',
        capacity: -1,
        links: [link()],
        ...over,
    };
}

const far = tag({ key: 'in:srt:ts', kind: 'in', moduleId: 'srt', page: 'pg-b', n: 8, label: '#8' });

function mountPanel(refNode: RefNode = tag()) {
    return mount(XrefSettingsPanel, {
        props: {
            refNode,
            pageNames: { 'pg-a': 'Ingest', 'pg-b': 'Studio' },
            moduleNames: { enc: 'Encoder', srt: 'SRT out' },
            portLabels: { 'enc:ts': 'TS Out' },
            refs: { [far.key]: far },
        },
        attachTo: document.body,
    });
}

// A rule-bound MrInput commits on change (Enter or leaving the box), not per keystroke.
async function commitName(w: ReturnType<typeof mountPanel>, text: string) {
    const input = w.get('input');
    (input.element as HTMLInputElement).value = text;
    await input.trigger('input');
    await input.trigger('change');
}

describe('XrefSettingsPanel', () => {
    it('shows kind, number, bound port, page, stream type and links', () => {
        const w = mountPanel();
        const text = w.text();
        expect(text).toContain('Output reference');
        expect(w.get('[data-test="number"]').text()).toBe('#7');
        expect(w.get('[data-test="module"]').text()).toBe('Encoder/TS Out');
        expect(text).toContain('Ingest');
        expect(text).toContain('muxed/mpegts');
        expect(w.get('[data-test="goto"]').text()).toBe('#8 · Studio · SRT out/ts');
        w.unmount();
    });

    it('renames on commit, trimmed', async () => {
        const w = mountPanel();
        await commitName(w, '  To studio ');
        expect(w.emitted('rename')).toEqual([['out:enc:ts', 'To studio']]);
        w.unmount();
    });

    it('clears the name with null so the number shows again', async () => {
        const w = mountPanel(tag({ name: 'To studio', label: 'To studio' }));
        await commitName(w, '   ');
        expect(w.emitted('rename')).toEqual([['out:enc:ts', null]]);
        w.unmount();
    });

    it('writes nothing for an unchanged name', async () => {
        const w = mountPanel(tag({ name: 'To studio', label: 'To studio' }));
        await commitName(w, 'To studio ');
        expect(w.emitted('rename')).toBeUndefined();
        w.unmount();
    });

    it('refuses a name over 40 characters', async () => {
        const w = mountPanel();
        await commitName(w, 'x'.repeat(41));
        expect(w.emitted('rename')).toBeUndefined();
        expect(w.find('[data-test="reason"]').exists()).toBe(true);
        w.unmount();
    });

    it('jumps, unlinks, selects the module and closes', async () => {
        const w = mountPanel();
        await w.get('[data-test="goto"]').trigger('click');
        await w.get('[data-test="unlink"]').trigger('click');
        await w.get('[data-test="module"]').trigger('click');
        await w.get('[data-test="close"]').trigger('click');
        expect(w.emitted('goto')).toEqual([['in:srt:ts']]);
        expect(w.emitted('unlink')).toEqual([['c1']]);
        expect(w.emitted('selectModule')).toEqual([['enc']]);
        expect(w.emitted('close')).toHaveLength(1);
        w.unmount();
    });

    it('closes on Escape', () => {
        const w = mountPanel();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(w.emitted('close')).toHaveLength(1);
        w.unmount();
    });

    it('shows a pending number while the manager assigns it', () => {
        const w = mountPanel(tag({ n: undefined, label: '…' }));
        expect(w.get('[data-test="number"]').text()).toBe('Assigning…');
        w.unmount();
    });

    it('locks the name and unlink of a read-only PCM tag', () => {
        const w = mountPanel(
            tag({
                readOnly: true,
                n: undefined,
                label: 'PCM',
                streamType: 'audio/pcm',
                links: [link({ readOnly: true })],
            }),
        );
        expect(w.get('input').attributes('disabled')).toBeDefined();
        expect(w.find('[data-test="unlink"]').exists()).toBe(false);
        expect(w.find('[data-test="goto"]').exists()).toBe(true);
        expect(w.get('[data-test="number"]').text()).toBe('None');
        w.unmount();
    });

    it('lists an input tag link by its feed', () => {
        const input = tag({ key: 'in:srt:ts', kind: 'in', moduleId: 'srt', page: 'pg-b' });
        const w = mountPanel(input);
        expect(w.text()).toContain('Input reference');
        expect(w.get('[data-test="goto"]').text()).toBe('Ingest · Encoder/TS Out');
        w.unmount();
    });
});
