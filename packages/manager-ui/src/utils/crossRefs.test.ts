import { describe, it, expect } from 'vitest';
import { emptyEditorLayout, type EditorLayout } from '@media-router/shared-types';
import type { ConnectionState, ModuleState, PortInfo } from '@/stores/engines';
import {
    IMPLICIT_PAGE_ID,
    deriveRefs,
    directOnPage,
    missingRefKeys,
    pageNamesOf,
    pageOf,
    refsOnPage,
    sortedPages,
    stubsOnPage,
} from './crossRefs';
import { IDLE_EDGE_COLOR } from './edgeStyle';

const CYAN = '#06b6d4';
const AMBER = '#f59e0b';

function port(
    id: string,
    direction: PortInfo['direction'],
    streamType = 'audio/302m',
    max = -1,
): PortInfo {
    return { id, direction, streamType, label: id, maxConnections: max };
}
function mod(id: string, ports: PortInfo[]): ModuleState {
    return {
        instanceId: id,
        pluginId: 'p',
        displayName: id.toUpperCase(),
        running: true,
        enabled: true,
        health: 'ok',
        pendingRestart: false,
        settings: {},
        ports,
    };
}
function conn(src: string, sink: string, srcPort = 'out', sinkPort = 'in'): ConnectionState {
    return {
        id: `${src}-${sink}`,
        sourceModuleId: src,
        sourcePortId: srcPort,
        sinkModuleId: sink,
        sinkPortId: sinkPort,
    };
}
/** Pages A (order 0) and B (order 1); `onB` lists the modules pinned to B, the rest sit on A. */
function layout(onB: string[], extra: Partial<EditorLayout> = {}): EditorLayout {
    return {
        ...emptyEditorLayout(),
        pages: { 'pg-a': { name: 'Intake', order: 0 }, 'pg-b': { name: 'Output', order: 1 } },
        modulePages: Object.fromEntries(onB.map((id) => [id, 'pg-b'])),
        ...extra,
    };
}
const derive = (
    modules: Record<string, ModuleState>,
    connections: ConnectionState[],
    editor?: EditorLayout,
) => deriveRefs(modules, connections, editor, pageNamesOf(editor));

const src = mod('src', [port('out', 'output')]);
const sinks = ['s1', 's2', 's3'].map((id) => mod(id, [port('in', 'input')]));
const fanOut = { src, ...Object.fromEntries(sinks.map((m) => [m.instanceId, m])) };
const fanConns = sinks.map((m) => conn('src', m.instanceId));

describe('pages', () => {
    it('an empty layout is one implicit "Page 1" holding every module', () => {
        expect(sortedPages(undefined)).toEqual([
            { id: IMPLICIT_PAGE_ID, name: 'Page 1', order: 0 },
        ]);
        expect(pageOf(emptyEditorLayout(), 'any')).toBe(IMPLICIT_PAGE_ID);
    });

    it('a missing or unknown stored page means the lowest-order page', () => {
        const editor = layout(['s1'], {
            pages: { 'pg-b': { name: 'Output', order: 1 }, 'pg-a': { name: 'Intake', order: 0 } },
        });
        editor.modulePages.s2 = 'pg-gone';
        expect(sortedPages(editor).map((p) => p.id)).toEqual(['pg-a', 'pg-b']);
        expect(pageOf(editor, 's1')).toBe('pg-b');
        expect(pageOf(editor, 's2')).toBe('pg-a');
        expect(pageOf(editor, 'unpinned')).toBe('pg-a');
    });
});

describe('deriveRefs', () => {
    it('a port with two nearby wires and one cross-page link draws 2 wires and 1 tag', () => {
        const editor = layout(['s3'], { refs: { 'out:src:out': { n: 4 } }, nextRef: 5 });
        const d = derive(fanOut, fanConns, editor);
        expect(d.directConnectionIds).toEqual(['src-s1', 'src-s2']);
        expect(d.links.map((l) => l.connectionId)).toEqual(['src-s3']);
        expect(Object.keys(d.refs)).toEqual(['out:src:out', 'in:s3:in']);
        expect(d.refs['out:src:out']).toMatchObject({
            kind: 'out',
            page: 'pg-a',
            n: 4,
            label: '#4',
            hint: '→ Output',
            color: CYAN,
            streamType: 'audio/302m',
            readOnly: false,
            capacity: -1,
        });
        expect(d.refs['in:s3:in']).toMatchObject({
            kind: 'in',
            page: 'pg-b',
            label: '…',
            hint: '← Intake',
        });
        expect(missingRefKeys(d)).toEqual(['in:s3:in']);
    });

    it('a second far module moved to another page joins the same tag (key and number)', () => {
        const refs = { 'out:src:out': { n: 4, name: 'Feed' } };
        const before = derive(fanOut, fanConns, layout(['s3'], { refs, nextRef: 5 }));
        const after = derive(fanOut, fanConns, layout(['s2', 's3'], { refs, nextRef: 5 }));
        expect(Object.keys(after.refs).filter((k) => k.startsWith('out:'))).toEqual([
            'out:src:out',
        ]);
        expect(after.refs['out:src:out']).toMatchObject({
            n: 4,
            label: 'Feed',
            name: 'Feed',
            hint: '→ 2 refs',
        });
        expect(after.refs['out:src:out'].links.map((l) => l.connectionId)).toEqual([
            'src-s2',
            'src-s3',
        ]);
        expect(after.directConnectionIds).toEqual(['src-s1']);
        expect(before.refs['out:src:out'].n).toBe(after.refs['out:src:out'].n);
    });

    it('"Show as cross-reference" on a wire from a tagged port joins the existing tag', () => {
        const editor = layout(['s3'], {
            refs: { 'out:src:out': { n: 1 } },
            tagged: { 'src-s1': true },
            nextRef: 2,
        });
        const d = derive(fanOut, fanConns, editor);
        expect(d.directConnectionIds).toEqual(['src-s2']);
        const tag = d.refs['out:src:out'];
        expect(tag.links.map((l) => [l.connectionId, l.tagged])).toEqual([
            ['src-s1', true],
            ['src-s3', false],
        ]);
        // The tagged wire's input tag sits on the same page as the output tag.
        expect(d.refs['in:s1:in']).toMatchObject({ page: 'pg-a', hint: '← Intake' });
        expect(stubsOnPage(d, 'pg-a').map((s) => s.id)).toEqual([
            'ref:out:src:out',
            'ref:in:s1:in',
        ]);
        expect(stubsOnPage(d, 'pg-a')[0].connectionIds).toEqual(['src-s1', 'src-s3']);
    });

    it('a mixer input with nearby and cross-page feeds: one input tag, coloured by the feed', () => {
        const mixer = mod('mix', [port('in', 'input', 'audio/302m', 8)]);
        const feeds = ['f1', 'f2', 'f3'].map((id) => mod(id, [port('out', 'output')]));
        const modules = { mix: mixer, ...Object.fromEntries(feeds.map((m) => [m.instanceId, m])) };
        const conns = feeds.map((f) => conn(f.instanceId, 'mix'));
        const d = derive(modules, conns, layout(['f2', 'f3']));
        expect(d.directConnectionIds).toEqual(['f1-mix']);
        expect(d.refs['in:mix:in']).toMatchObject({
            capacity: 8,
            color: CYAN,
            hint: '← 2 refs',
            page: 'pg-a',
        });
        expect(d.refs['in:mix:in'].links).toHaveLength(2);
        expect(refsOnPage(d, 'pg-b').map((r) => r.key)).toEqual(['out:f2:out', 'out:f3:out']);
    });

    it('an input tag takes its feed type: MPEG-TS into an any-TS input is amber', () => {
        const modules = {
            a: mod('a', [port('out', 'output', 'muxed/mpegts')]),
            b: mod('b', [port('in', 'input', 'audio/302m')]),
        };
        const d = derive(modules, [conn('a', 'b')], layout(['b']));
        expect(d.refs['in:b:in']).toMatchObject({ streamType: 'muxed/mpegts', color: AMBER });
    });

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
