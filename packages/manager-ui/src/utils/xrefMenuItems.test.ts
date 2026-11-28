import { describe, it, expect } from 'vitest';
import type { RefLink, RefNode } from '@/utils/crossRefTypes';
import {
    buildXrefMenuItems,
    counterpartLabel,
    counterpartOf,
    portLabelKey,
    type XrefMenuContext,
} from './xrefMenuItems';

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
        n: 1,
        label: '#1',
        hint: '→ Studio',
        capacity: -1,
        links: [link()],
        ...over,
    };
}

function ctx(refs: RefNode[], over: Partial<XrefMenuContext> = {}): XrefMenuContext {
    return {
        refs: Object.fromEntries(refs.map((r) => [r.key, r])),
        pageNames: { 'pg-a': 'Ingest', 'pg-b': 'Studio' },
        moduleNames: { enc: 'Encoder', srt: 'SRT out', mix: 'Mixer' },
        hasCapacity: true,
        ...over,
    };
}

const actions = (items: { action: string; divider?: boolean }[]) =>
    items.map((i) => (i.divider ? '---' : i.action));

describe('buildXrefMenuItems', () => {
    const far = tag({
        key: 'in:srt:ts',
        kind: 'in',
        moduleId: 'srt',
        page: 'pg-b',
        n: 2,
        label: '#2',
    });

    it('lists a jump to the far tag, then label and unlink, then link and settings', () => {
        const out = tag();
        const items = buildXrefMenuItems(out, ctx([out, far]));
        expect(actions(items)).toEqual([
            'goto:in:srt:ts',
            'label:c1',
            'unlink:c1',
            '---',
            'link',
            'settings',
        ]);
        expect(items[0].label).toBe('#2 · Studio · SRT out/ts');
        expect(items.find((i) => i.action === 'unlink:c1')?.danger).toBe(true);
    });

    it('names the far port by its label when given, and uses the far tag name', () => {
        const named = { ...far, name: 'To studio', label: 'To studio' };
        const out = tag();
        const items = buildXrefMenuItems(
            out,
            ctx([out, named], { portLabels: { [portLabelKey('srt', 'ts')]: 'TS In' } }),
        );
        expect(items[0].label).toBe('To studio · Studio · SRT out/TS In');
    });

    it('offers a channel map on audio links only', () => {
        const audio = tag({ streamType: 'audio/302m' });
        expect(actions(buildXrefMenuItems(audio, ctx([audio, far])))).toContain('chmap:c1');
        const ts = tag();
        expect(actions(buildXrefMenuItems(ts, ctx([ts, far])))).not.toContain('chmap:c1');
    });

    it('reads an input tag link type from its feed, not the input', () => {
        const feed = tag({ key: 'out:enc:ts', streamType: 'audio/302m' });
        const input = tag({ key: 'in:srt:ts', kind: 'in', streamType: null });
        expect(actions(buildXrefMenuItems(input, ctx([feed, input])))).toContain('chmap:c1');
    });

    it('offers "Show as wire" only on a tagged same-page link', () => {
        const same = tag({ links: [link({ tagged: true, sinkPage: 'pg-a' })] });
        expect(actions(buildXrefMenuItems(same, ctx([same, far])))).toContain('wire:c1');
        const crossTagged = tag({ links: [link({ tagged: true })] });
        expect(actions(buildXrefMenuItems(crossTagged, ctx([crossTagged, far])))).not.toContain(
            'wire:c1',
        );
        const untagged = tag({ links: [link({ sinkPage: 'pg-a' })] });
        expect(actions(buildXrefMenuItems(untagged, ctx([untagged, far])))).not.toContain(
            'wire:c1',
        );
    });

    it('groups a fan-out tag per link, divided', () => {
        const fan = tag({
            links: [
                link(),
                link({
                    connectionId: 'c2',
                    inKey: 'in:mix:a',
                    sinkModuleId: 'mix',
                    sinkPortId: 'a',
                }),
            ],
        });
        expect(actions(buildXrefMenuItems(fan, ctx([fan, far])))).toEqual([
            'goto:in:srt:ts',
            'label:c1',
            'unlink:c1',
            '---',
            'goto:in:mix:a',
            'label:c2',
            'unlink:c2',
            '---',
            'link',
            'settings',
        ]);
    });

    it('jumps from an input tag to the output tag of each feed', () => {
        const input = tag({ key: 'in:srt:ts', kind: 'in', moduleId: 'srt', page: 'pg-b' });
        const items = buildXrefMenuItems(input, ctx([input, tag()]));
        expect(items[0]).toMatchObject({
            action: 'goto:out:enc:ts',
            label: '#1 · Ingest · Encoder/ts',
        });
    });

    it('leaves out "Link to another page…" when the port is full', () => {
        const out = tag();
        expect(
            actions(buildXrefMenuItems(out, ctx([out, far], { hasCapacity: false }))),
        ).not.toContain('link');
    });

    it('explains a read-only PCM tag and offers no link or unlink', () => {
        const pcmLink = link({
            readOnly: true,
            outKey: 'out:mic:pcm',
            inKey: 'in:mix:pcm',
            sinkModuleId: 'mix',
            sinkPortId: 'pcm',
        });
        const pcm = tag({
            key: 'out:mic:pcm',
            streamType: 'audio/pcm',
            color: '#6b7280',
            readOnly: true,
            n: undefined,
            label: 'PCM',
            links: [pcmLink],
        });
        const items = buildXrefMenuItems(pcm, ctx([pcm]));
        expect(items[0]).toMatchObject({
            label: 'PipeWire wire across pages: move these modules together',
            disabled: true,
        });
        const acts = actions(items);
        expect(acts).toContain('goto:in:mix:pcm');
        expect(acts).not.toContain('unlink:c1');
        expect(acts).not.toContain('link');
        expect(acts[acts.length - 1]).toBe('settings');
        // A jump to a tag not (yet) derived still reads.
        expect(items.find((i) => i.action === 'goto:in:mix:pcm')?.label).toBe('Studio · Mixer/pcm');
    });

    it('never doubles a divider', () => {
        const lonely = tag({ readOnly: true, links: [] });
        const items = buildXrefMenuItems(lonely, ctx([lonely]));
        items.forEach((item, i) => expect(item.divider && items[i + 1]?.divider).toBeFalsy());
    });
});

describe('counterpartOf / counterpartLabel', () => {
    it('picks the far end by the tag kind', () => {
        const l = link();
        expect(counterpartOf({ kind: 'out' }, l)).toEqual({
            key: 'in:srt:ts',
            moduleId: 'srt',
            portId: 'ts',
            page: 'pg-b',
        });
        expect(counterpartOf({ kind: 'in' }, l).key).toBe('out:enc:ts');
    });

    it('falls back to ids for unknown names', () => {
        expect(
            counterpartLabel({ kind: 'out' }, link(), { refs: {}, pageNames: {}, moduleNames: {} }),
        ).toBe('srt/ts');
    });
});
