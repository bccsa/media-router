import { describe, it, expect } from 'vitest';
import { directOnPage, IMPLICIT_PAGE_ID, missingRefKeys, stalePositionKeys } from './crossRefs';
import { IDLE_EDGE_COLOR } from './edgeStyle';
import {
    conn,
    CYAN,
    derive,
    fanConns,
    fanOut,
    layout,
    mod,
    port,
} from '@/testing/crossRefsFixture';

describe('deriveRefs: grey tags and the whole graph', () => {
    it('a PipeWire wire across pages is a grey read-only tag; tagged is ignored for PCM', () => {
        const modules = {
            mic: mod('mic', [port('out', 'output', 'audio/pcm')]),
            spk: mod('spk', [port('in', 'input', 'audio/pcm')]),
            mon: mod('mon', [port('in', 'input', 'audio/pcm')]),
        };
        const conns = [conn('mic', 'spk'), conn('mic', 'mon')];
        const editor = layout(['spk'], {
            refs: { 'out:mic:out': { n: 3, name: 'Old' } },
            tagged: { 'mic-mon': true },
            nextRef: 4,
        });
        const d = derive(modules, conns, editor);
        expect(d.directConnectionIds).toEqual(['mic-mon']);
        expect(d.links[0]).toMatchObject({
            connectionId: 'mic-spk',
            readOnly: true,
            tagged: false,
        });
        expect(d.refs['out:mic:out']).toMatchObject({
            readOnly: true,
            color: IDLE_EDGE_COLOR,
            label: 'PCM',
            n: undefined,
            name: undefined,
        });
        expect(d.refs['in:spk:in']).toMatchObject({ readOnly: true, label: 'PCM' });
        expect(missingRefKeys(d)).toEqual([]);
    });

    it('a vanished port: grey "?" tag across pages, an ordinary wire on one page', () => {
        const modules = { a: mod('a', [port('out', 'output')]), b: mod('b', []), c: mod('c', []) };
        const conns = [conn('a', 'b'), conn('a', 'c')];
        const d = derive(modules, conns, layout(['b'], { tagged: { 'a-c': true } }));
        expect(d.directConnectionIds).toEqual(['a-c']);
        expect(d.refs['in:b:in']).toMatchObject({
            readOnly: true,
            label: '?',
            color: IDLE_EDGE_COLOR,
            streamType: 'audio/302m',
        });
        // The output port is fine, but its only link is read-only.
        expect(d.refs['out:a:out']).toMatchObject({ readOnly: true, color: IDLE_EDGE_COLOR });
    });

    it('a tag with a read-only and a numbered link keeps its number and colour', () => {
        const modules = { ...fanOut, s3: mod('s3', []) };
        const editor = layout(['s2', 's3'], { refs: { 'out:src:out': { n: 9 } }, nextRef: 10 });
        const tag = derive(modules, fanConns, editor).refs['out:src:out'];
        expect(tag).toMatchObject({ readOnly: false, n: 9, color: CYAN });
        expect(tag.links.map((l) => l.readOnly)).toEqual([false, true]);
    });

    it('is total: every connection between existing modules is a wire or a tag link; dangling ones are skipped', () => {
        const conns = [...fanConns, conn('src', 'gone'), conn('gone', 's1')];
        const d = derive(fanOut, conns, layout(['s1']));
        const drawn = [...d.directConnectionIds, ...d.links.map((l) => l.connectionId)].sort();
        expect(drawn).toEqual(['src-s1', 'src-s2', 'src-s3']);
    });

    it('with no layout everything is a direct wire on the implicit page', () => {
        const d = derive(fanOut, fanConns, undefined);
        expect(d.links).toEqual([]);
        expect(directOnPage(d, fanConns, undefined, IMPLICIT_PAGE_ID)).toEqual(fanConns);
    });

    it("directOnPage keeps the page's own wires", () => {
        const editor = layout(['s2', 'src']);
        const d = derive(fanOut, fanConns, editor);
        expect(directOnPage(d, fanConns, editor, 'pg-b').map((c) => c.id)).toEqual(['src-s2']);
        expect(directOnPage(d, fanConns, editor, 'pg-a')).toEqual([]);
    });
});

describe('stalePositionKeys', () => {
    it('lists stored records with a dragged place and no tag drawn; names and numbers stay', () => {
        const editor = layout(['s1'], {
            refs: {
                'out:src:out': { n: 1, pos: { x: 1, y: 1 } },
                'in:s1:in': { n: 2, pos: { x: 2, y: 2 } },
                'in:s2:in': { n: 3, name: 'Back home', pos: { x: 3, y: 3 } },
                'in:s3:in': { n: 4 },
            },
            nextRef: 5,
        });
        // s2 and s3 are on src's page: their wires are direct, so their tags are gone.
        expect(stalePositionKeys(editor, derive(fanOut, fanConns, editor))).toEqual(['in:s2:in']);
        expect(stalePositionKeys(undefined, derive(fanOut, fanConns))).toEqual([]);
    });
});
